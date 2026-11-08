import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { CancelTimer, Clock } from "../lib/clock.ts";
import { loadPersona } from "./loader.ts";
import type { Persona } from "./schema.ts";

const DEBOUNCE_MS = 300;

/** Reloads the persona when its file changes. A broken edit keeps the last good version running. */
export function watchPersona(options: {
    path: string;
    timezoneOverride?: string;
    clock: Clock;
    onReload: (persona: Persona) => void;
    onError: (message: string) => void;
}): () => void {
    const { path, timezoneOverride, clock, onReload, onError } = options;
    const file = basename(path);
    let cancel: CancelTimer | undefined;
    const reload = () => {
        try {
            onReload(loadPersona(path, timezoneOverride));
        } catch (error) {
            onError(error instanceof Error ? error.message : String(error));
        }
    };
    // Watching the directory, because many editors save by replacing the file.
    const watcher = watch(dirname(path), (_event, changed) => {
        if (changed !== file) return;
        cancel?.();
        cancel = clock.setTimer(DEBOUNCE_MS, reload);
    });
    return () => {
        cancel?.();
        watcher.close();
    };
}
