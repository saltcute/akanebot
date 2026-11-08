import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SOURCE_FILES = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .map((path) => join("src", path).replaceAll("\\", "/"));

function violations(pattern: RegExp, allowed: (path: string) => boolean): string[] {
    return SOURCE_FILES.filter((path) => !allowed(path)).flatMap((path) =>
        readFileSync(join(ROOT, path), "utf8")
            .split("\n")
            .flatMap((line, index) => (pattern.test(line) ? [`${relative(ROOT, join(ROOT, path))}:${index + 1}: ${line.trim()}`] : [])),
    );
}

describe("architecture rules", () => {
    it("finds the source tree", () => {
        expect(SOURCE_FILES.length).toBeGreaterThan(5);
    });

    it("keeps vendor SDKs and model names inside src/llm", () => {
        const vendor = /@anthropic-ai|openai|\bclaude-|\bgpt-\d|qwen|deepseek|\bllama/i;
        expect(violations(vendor, (path) => path.startsWith("src/llm/"))).toEqual([]);
    });

    it("takes time and randomness only from the injected clock and RNG", () => {
        const ambient = /Date\.now\(|new Date\(\)|Math\.random\(|\bsetTimeout\(|\bsetInterval\(/;
        expect(violations(ambient, (path) => path === "src/lib/clock.ts")).toEqual([]);
    });
});
