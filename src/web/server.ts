import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { MAX_MUTE_MINUTES } from "../control/admin.ts";
import { isShareable } from "../memory/reach.ts";
import type { MemoryView } from "../memory/store.ts";
import type { Runtime } from "../runtime.ts";

const MAX_BODY_BYTES = 64_000;
const MIN_TOKEN_CHARS = 16;
const MAX_ALERTS = 30;
const MAX_GIST_CHARS = 4000;
const MAX_DETAIL_CHARS = 20_000;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

const ASSETS: ReadonlyMap<string, { file: string; type: string }> = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
    ["/ui.js", { file: "ui.js", type: "text/javascript; charset=utf-8" }],
    ["/dialogs.js", { file: "dialogs.js", type: "text/javascript; charset=utf-8" }],
    ["/people.js", { file: "people.js", type: "text/javascript; charset=utf-8" }],
    ["/status.js", { file: "status.js", type: "text/javascript; charset=utf-8" }],
    ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
]);

/** Chat text is written by strangers, so the page may only ever run its own script and talk to its own server. */
const SECURITY_HEADERS = {
    "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
};

const memoryQuerySchema = z.object({
    scope: z.string().min(1).optional(),
    kind: z.enum(["episode", "fact", "claim", "event"]).optional(),
    reach: z.enum(["group", "shared"]).optional(),
    state: z.enum(["active", "archived", "replaced"]).optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    offset: z.coerce.number().int().min(0).default(0),
});

const memoryEditSchema = z.strictObject({
    gist: z.string().trim().min(1).max(MAX_GIST_CHARS),
    detail: z.string().trim().max(MAX_DETAIL_CHARS),
    importance: z.number().min(0).max(1),
});

const reachSchema = z.strictObject({ reach: z.enum(["group", "shared"]) });

const muteSchema = z.strictObject({ minutes: z.number().positive().max(MAX_MUTE_MINUTES) });

const standingSchema = z
    .strictObject({ familiarity: z.number().min(0).max(1).optional(), affinity: z.number().min(-1).max(1).optional() })
    .refine((correction) => correction.familiarity !== undefined || correction.affinity !== undefined, "Nothing to change");

class HttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

type ApiRequest = { params: readonly string[]; query: URLSearchParams; body: unknown };
type Route = { method: string; path: RegExp; handle: (request: ApiRequest) => unknown };

export type WebServerOptions = {
    runtime: Runtime;
    token: string;
    host: string;
    port: number;
    onError: (message: string) => void;
};

/** Uses the configured token, or makes one up for this run so the UI is never open by accident. */
export function resolveWebToken(configured: string | undefined): { token: string; generated: boolean } {
    if (!configured) return { token: randomBytes(24).toString("hex"), generated: true };
    if (configured.length < MIN_TOKEN_CHARS) throw new Error(`AKANEBOT_WEB_TOKEN must be at least ${MIN_TOKEN_CHARS} characters.`);
    return { token: configured, generated: false };
}

export function isLoopback(host: string): boolean {
    return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** The operator's window into the running bot. It lives in the bot's process, because live conversations exist nowhere else. */
export class WebServer {
    #options: WebServerOptions;
    #tokenDigest: Buffer;
    #routes: readonly Route[];
    #assets = new Map<string, { content: Buffer; type: string }>();
    #server: Server | undefined;

    constructor(options: WebServerOptions) {
        this.#options = options;
        this.#tokenDigest = digest(options.token);
        this.#routes = buildRoutes(options.runtime);
        for (const [path, { file, type }] of ASSETS) {
            this.#assets.set(path, { content: readFileSync(new URL(`./public/${file}`, import.meta.url)), type });
        }
    }

    /** Resolves with the address actually bound, which matters when the port is 0. */
    async start(): Promise<string> {
        const server = createServer((request, response) => void this.#handle(request, response));
        this.#server = server;
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.#options.port, this.#options.host, () => {
                server.off("error", reject);
                resolve();
            });
        });
        const { port } = server.address() as AddressInfo;
        const host = this.#options.host.includes(":") ? `[${this.#options.host}]` : this.#options.host;
        return `http://${host}:${port}/`;
    }

    async stop(): Promise<void> {
        const server = this.#server;
        if (!server) return;
        this.#server = undefined;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }

    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            const url = new URL(request.url ?? "/", "http://localhost");
            if (url.pathname.startsWith("/api/")) await this.#handleApi(request, response, url);
            else this.#serveAsset(request, response, url.pathname);
        } catch (error) {
            this.#respondToError(response, error);
        }
    }

    #serveAsset(request: IncomingMessage, response: ServerResponse, path: string): void {
        const asset = this.#assets.get(path);
        if (!asset) throw new HttpError(404, "Not found");
        if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed");
        response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset.type });
        response.end(request.method === "HEAD" ? undefined : asset.content);
    }

    async #handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
        if (!this.#isAuthorized(request)) throw new HttpError(401, "Unauthorized");
        const matching = this.#routes.flatMap((route) => {
            const match = route.path.exec(url.pathname);
            return match ? [{ route, match }] : [];
        });
        if (matching.length === 0) throw new HttpError(404, "Not found");
        const found = matching.find(({ route }) => route.method === request.method);
        if (!found) throw new HttpError(405, "Method not allowed");
        const body = await readJsonBody(request);
        const result = await found.route.handle({ params: found.match.slice(1).map(decodeParam), query: url.searchParams, body });
        sendJson(response, 200, result ?? { ok: true });
    }

    /** A bearer token rather than a cookie, so another site can't make the browser act on the operator's behalf. */
    #isAuthorized(request: IncomingMessage): boolean {
        const presented = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
        return presented !== undefined && timingSafeEqual(digest(presented), this.#tokenDigest);
    }

    #respondToError(response: ServerResponse, error: unknown): void {
        if (error instanceof HttpError) {
            sendJson(response, error.status, { error: error.message });
        } else if (error instanceof z.ZodError) {
            sendJson(response, 400, { error: z.prettifyError(error) });
        } else {
            this.#options.onError(String(error));
            sendJson(response, 500, { error: "Something went wrong. Check the operator alerts." });
        }
    }
}

function buildRoutes(runtime: Runtime): readonly Route[] {
    const { store } = runtime.memory;

    const conversationKey = (request: ApiRequest): string => {
        const key = request.params[0] ?? "";
        if (!runtime.hasConversation(key)) throw new HttpError(404, "No such conversation");
        return key;
    };
    const memoryId = (request: ApiRequest): number => {
        const id = Number(request.params[0]);
        if (!store.get(id)) throw new HttpError(404, "No such memory");
        return id;
    };
    const personKey = (request: ApiRequest): string => {
        const key = request.params[0] ?? "";
        if (!/^[a-z]+:.+$/.test(key) || key.endsWith(":self")) throw new HttpError(400, "Not a person");
        return key;
    };
    const audit = (action: string, memory: number) => runtime.noteOperatorAction(action, { memory });
    const describeKey = (key: string | null): string | null => (key ? (store.displayNameOf(key) ?? key.replace(/^name:/, "")) : null);
    const present = (memory: MemoryView) => ({
        ...memory,
        scopeName: runtime.channelName(memory.scope) ?? memory.scope,
        shareable: isShareable(memory),
        subjectName: describeKey(memory.subject),
        attributedToName: describeKey(memory.attributedTo),
    });

    return [
        { method: "GET", path: /^\/api\/status$/, handle: () => ({ ...runtime.status(), alerts: runtime.recentAlerts(MAX_ALERTS) }) },
        {
            method: "POST",
            path: /^\/api\/control\/kill$/,
            handle: () => {
                runtime.kill();
            },
        },
        {
            method: "POST",
            path: /^\/api\/control\/resume$/,
            handle: () => {
                runtime.resume();
            },
        },

        { method: "GET", path: /^\/api\/conversations$/, handle: () => ({ conversations: runtime.conversations() }) },
        { method: "GET", path: /^\/api\/conversations\/([^/]+)$/, handle: (request) => runtime.conversation(conversationKey(request)) },
        {
            method: "POST",
            path: /^\/api\/conversations\/([^/]+)\/mute$/,
            handle: (request) => {
                runtime.muteConversation(conversationKey(request), muteSchema.parse(request.body).minutes);
            },
        },
        {
            method: "POST",
            path: /^\/api\/conversations\/([^/]+)\/unmute$/,
            handle: (request) => {
                runtime.unmuteConversation(conversationKey(request));
            },
        },
        {
            method: "POST",
            path: /^\/api\/conversations\/([^/]+)\/read$/,
            handle: (request) => {
                runtime.markConversationRead(conversationKey(request));
            },
        },
        {
            method: "POST",
            path: /^\/api\/conversations\/([^/]+)\/digest$/,
            handle: async (request) => ({ undigested: await runtime.digestConversation(conversationKey(request)) }),
        },
        {
            method: "GET",
            path: /^\/api\/messages\/([^/]+)\/decisions$/,
            handle: (request) => ({ decisions: runtime.decisionsAbout(request.params[0] ?? "") }),
        },

        {
            method: "GET",
            path: /^\/api\/memories$/,
            handle: (request) => {
                const { q, ...filters } = memoryQuerySchema.parse(Object.fromEntries(request.query));
                const { memories, total } = store.browse({ ...filters, text: q });
                const scopes = store.scopes().map((key) => ({ key, name: runtime.channelName(key) ?? key }));
                return { memories: memories.map(present), total, scopes };
            },
        },
        {
            method: "GET",
            path: /^\/api\/memories\/(\d+)$/,
            handle: (request) => {
                const id = memoryId(request);
                const memory = store.view(id);
                if (!memory) throw new HttpError(404, "No such memory");
                const sources = store.sourcesOf(id).map((source) => ({ ...source, displayName: source.displayName ?? describeKey(source.speaker) }));
                return { ...present(memory), sources };
            },
        },
        {
            method: "PATCH",
            path: /^\/api\/memories\/(\d+)$/,
            handle: (request) => {
                const id = memoryId(request);
                runtime.memory.edit(id, memoryEditSchema.parse(request.body));
                audit("edit_memory", id);
            },
        },
        {
            method: "POST",
            path: /^\/api\/memories\/(\d+)\/reach$/,
            handle: (request) => {
                const id = memoryId(request);
                const { reach } = reachSchema.parse(request.body);
                const memory = store.view(id);
                if (reach === "shared" && memory && !isShareable(memory)) throw new HttpError(400, "This kind of memory can't leave its group");
                store.setReach(id, reach);
                audit("set_memory_reach", id);
            },
        },
        {
            method: "POST",
            path: /^\/api\/memories\/(\d+)\/archive$/,
            handle: (request) => {
                const id = memoryId(request);
                store.setStatus(id, "archived");
                audit("archive_memory", id);
            },
        },
        {
            method: "POST",
            path: /^\/api\/memories\/(\d+)\/restore$/,
            handle: (request) => {
                const id = memoryId(request);
                store.supersede(id, null);
                store.setStatus(id, "active");
                audit("restore_memory", id);
            },
        },
        {
            method: "DELETE",
            path: /^\/api\/memories\/(\d+)$/,
            handle: (request) => {
                const id = memoryId(request);
                store.forget(id);
                audit("delete_memory", id);
            },
        },

        { method: "GET", path: /^\/api\/body$/, handle: () => runtime.bodySnapshot() },
        { method: "GET", path: /^\/api\/people$/, handle: () => ({ people: runtime.roster() }) },
        {
            method: "GET",
            path: /^\/api\/people\/([^/]+)$/,
            handle: (request) => {
                const key = personKey(request);
                return { key, displayName: store.displayNameOf(key) ?? key, ...runtime.memory.forgetImpact(key) };
            },
        },
        {
            method: "DELETE",
            path: /^\/api\/people\/([^/]+)$/,
            handle: (request) => ({ forgotten: runtime.forgetPerson(personKey(request)) }),
        },
        {
            method: "POST",
            path: /^\/api\/people\/([^/]+)\/opt-out$/,
            handle: (request) => ({ forgotten: runtime.optOutPerson(personKey(request)) }),
        },
        {
            method: "POST",
            path: /^\/api\/people\/([^/]+)\/opt-in$/,
            handle: (request) => {
                runtime.optInPerson(personKey(request));
            },
        },
        {
            method: "PATCH",
            path: /^\/api\/people\/([^/]+)\/relationship$/,
            handle: (request) => {
                const key = personKey(request);
                const { familiarity, affinity } = standingSchema.parse(request.body);
                const correction = { ...(familiarity === undefined ? {} : { familiarity }), ...(affinity === undefined ? {} : { affinity }) };
                if (!runtime.correctStanding(key, correction)) throw new HttpError(404, "She has no feelings about this person yet");
            },
        },
        {
            method: "DELETE",
            path: /^\/api\/people\/([^/]+)\/relationship$/,
            handle: (request) => {
                runtime.resetStanding(personKey(request));
            },
        },
    ];
}

function digest(value: string): Buffer {
    return createHash("sha256").update(value).digest();
}

function decodeParam(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        throw new HttpError(400, "Bad address");
    }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    if (request.method === "GET" || request.method === "HEAD") return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, "Too large");
        chunks.push(chunk);
    }
    if (size === 0) return undefined;
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "Not valid JSON");
    }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
}
