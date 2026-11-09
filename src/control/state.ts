import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ChatMessage } from "../adapters/types.ts";
import type { Clock } from "../lib/clock.ts";
import { NO_LINKS, type People } from "./people.ts";

const snapshotSchema = z.object({
    killed: z.boolean(),
    mutedUntil: z.record(z.string(), z.number()),
    optedOut: z.array(z.string()),
});

export type ControlSnapshot = z.infer<typeof snapshotSchema>;

export interface ControlStore {
    load(): ControlSnapshot | undefined;
    save(snapshot: ControlSnapshot): void;
}

/** A corrupt file stops startup, because silently forgetting an opt-out would be worse than not running. */
export class JsonFileControlStore implements ControlStore {
    #path: string;

    constructor(path: string) {
        this.#path = path;
    }

    load(): ControlSnapshot | undefined {
        if (!existsSync(this.#path)) return undefined;
        return snapshotSchema.parse(JSON.parse(readFileSync(this.#path, "utf8")));
    }

    save(snapshot: ControlSnapshot): void {
        mkdirSync(dirname(this.#path), { recursive: true });
        const temporary = `${this.#path}.tmp`;
        writeFileSync(temporary, JSON.stringify(snapshot, null, 2));
        renameSync(temporary, this.#path);
    }
}

export class MemoryControlStore implements ControlStore {
    saved: ControlSnapshot | undefined;

    load(): ControlSnapshot | undefined {
        return this.saved;
    }

    save(snapshot: ControlSnapshot): void {
        this.saved = snapshot;
    }
}

export function userKey(message: ChatMessage): string {
    return `${message.platform}:${message.sender.id}`;
}

/** The switches an operator or member can flip. Survives restarts. */
export class ControlState {
    #clock: Clock;
    #store: ControlStore;
    #killed: boolean;
    #mutedUntil: Map<string, number>;
    #optedOut: Set<string>;
    #people: People;

    constructor(options: { clock: Clock; store: ControlStore; people?: People }) {
        this.#clock = options.clock;
        this.#people = options.people ?? NO_LINKS;
        this.#store = options.store;
        const snapshot = options.store.load();
        this.#killed = snapshot?.killed ?? false;
        this.#mutedUntil = new Map(Object.entries(snapshot?.mutedUntil ?? {}));
        this.#optedOut = new Set(snapshot?.optedOut ?? []);
    }

    get killed(): boolean {
        return this.#killed;
    }

    setKilled(killed: boolean): void {
        this.#killed = killed;
        this.#persist();
    }

    isMuted(channel: string): boolean {
        return (this.#mutedUntil.get(channel) ?? 0) > this.#clock.now();
    }

    /** When the mute ends, or undefined if this channel isn't muted. */
    mutedUntil(channel: string): number | undefined {
        return this.isMuted(channel) ? this.#mutedUntil.get(channel) : undefined;
    }

    mute(channel: string, durationMs: number): void {
        this.#mutedUntil.set(channel, this.#clock.now() + durationMs);
        this.#persist();
    }

    unmute(channel: string): void {
        this.#mutedUntil.delete(channel);
        this.#persist();
    }

    /** Opting out covers the person, so it holds on every account they're linked to. */
    isOptedOut(user: string): boolean {
        return this.#people.accountsOf(user).some((account) => this.#optedOut.has(account));
    }

    optOut(user: string): void {
        this.#optedOut.add(user);
        this.#persist();
    }

    optIn(user: string): void {
        for (const account of this.#people.accountsOf(user)) this.#optedOut.delete(account);
        this.#persist();
    }

    #persist(): void {
        this.#store.save({ killed: this.#killed, mutedUntil: Object.fromEntries(this.#mutedUntil), optedOut: [...this.#optedOut] });
    }
}
