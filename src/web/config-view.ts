import { isDeepStrictEqual } from "node:util";
import { type AppConfig, loadConfig } from "../config.ts";
import { describeLlmConfig } from "../llm/registry.ts";

type DiskStatus = { state: "matches" } | { state: "differs"; sections: string[] } | { state: "unreadable" };

/** Just where it connects. A URL can carry an access token in its query or user info. */
function describeUrl(url: string): string {
    try {
        const { protocol, host } = new URL(url);
        return `${protocol}//${host}`;
    } catch {
        return "(hidden)";
    }
}

/** Written out field by field, so something new in the config stays hidden until someone decides it's safe to show. */
function describeConfig(config: AppConfig) {
    const { commandPrefix, admins, groups, statePath } = config.control;
    return {
        persona: config.persona,
        shadow: config.shadow,
        dailyBudgetUsd: config.dailyBudgetUsd,
        prices: config.prices,
        llm: describeLlmConfig(config),
        embedder: config.embedder,
        search: config.search,
        links: config.links,
        timing: config.timing,
        pacing: config.pacing,
        pictures: config.pictures,
        limits: config.limits,
        memory: config.memory,
        control: { commandPrefix, admins, groups, statePath },
        people: { linked: config.people.length },
        qq: config.qq ? { url: describeUrl(config.qq.url) } : undefined,
        web: config.web,
    };
}

/** Only names the sections that changed, because a parser's error message can quote the file. */
function diskStatus(running: AppConfig, path: string): DiskStatus {
    let onDisk: AppConfig;
    try {
        onDisk = loadConfig(path).config;
    } catch {
        return { state: "unreadable" };
    }
    const sections = Object.keys({ ...running, ...onDisk }).filter(
        (section) => !isDeepStrictEqual(running[section as keyof AppConfig], onDisk[section as keyof AppConfig]),
    );
    return sections.length === 0 ? { state: "matches" } : { state: "differs", sections };
}

/** `overrides` says what a run such as the simulator replaces, since the file then doesn't describe what's running. */
export function createConfigView(config: AppConfig, path: string, overrides: readonly string[] = []): () => unknown {
    return () => ({ path, overrides, disk: diskStatus(config, path), config: describeConfig(config) });
}
