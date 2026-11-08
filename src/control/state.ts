import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ChatMessage } from "../adapters/types.ts";
import type { Clock } from "../lib/clock.ts";

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

    constructor(options: { clock: Clock; store: ControlStore }) {
        this.#clock = options.clock;
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

    mute(channel: string, durationMs: number): void {
        this.#mutedUntil.set(channel, this.#clock.now() + durationMs);
        this.#persist();
    }

    unmute(channel: string): void {
        this.#mutedUntil.delete(channel);
        this.#persist();
    }

    isOptedOut(user: string): boolean {
        return this.#optedOut.has(user);
    }

    optOut(user: string): void {
        this.#optedOut.add(user);
        this.#persist();
    }

    optIn(user: string): void {
        this.#optedOut.delete(user);
        this.#persist();
    }

    #persist(): void {
        this.#store.save({ killed: this.#killed, mutedUntil: Object.fromEntries(this.#mutedUntil), optedOut: [...this.#optedOut] });
    }
}
