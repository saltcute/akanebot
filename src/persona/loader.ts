import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { isTimeZone, type Persona, personaSettingsSchema } from "./schema.ts";

export function loadPersona(path: string, timezoneOverride?: string): Persona {
    return parsePersona(readFileSync(path, "utf8"), path, timezoneOverride);
}

/** Errors name the file and line, because a maintainer edits this by hand. */
export function parsePersona(source: string, path = "persona", timezoneOverride?: string): Persona {
    if (timezoneOverride && !isTimeZone(timezoneOverride)) throw new Error(`GABRIEL_TIMEZONE: unknown time zone "${timezoneOverride}"`);

    const normalized = source.replaceAll("\r\n", "\n");
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
    if (!match) throw new Error(`${path}: expected YAML frontmatter between --- lines at the top of the file`);
    const frontmatter = match[1] ?? "";
    const prose = (match[2] ?? "").trim();

    let raw: unknown;
    try {
        raw = parse(frontmatter);
    } catch (error) {
        throw new Error(`${path}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }

    const parsed = personaSettingsSchema.safeParse(timezoneOverride ? { ...(raw as object), timezone: timezoneOverride } : raw);
    if (!parsed.success) {
        const problems = parsed.error.issues.map((issue) => {
            const key = issue.path.at(-1);
            const line = typeof key === "string" ? lineOfKey(frontmatter, key) : undefined;
            return `${path}${line ? `:${line}` : ""}: ${issue.path.join(".") || "(top level)"}: ${issue.message}`;
        });
        throw new Error(problems.join("\n"));
    }
    return { ...parsed.data, prose };
}

function lineOfKey(frontmatter: string, key: string): number | undefined {
    const index = frontmatter.split("\n").findIndex((line) => line.trimStart().startsWith(`${key}:`));
    // The frontmatter starts on line 2 of the file, after the opening ---.
    return index === -1 ? undefined : index + 2;
}
