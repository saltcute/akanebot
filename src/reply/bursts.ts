import { SILENCE_TOKEN } from "./prompt.ts";

const MAX_BURSTS = 4;
/** Models sometimes echo the transcript's tag style around a reply. Only these names, so HTML in code answers survives. */
const STRAY_WRAPPER_TAG = /<\/?(?:chat[\w-]*|reply|response|message|output)>/gi;

/** Each output line is one chat message, except that a fenced code block stays in one piece. */
export function splitBursts(text: string): string[] {
    const trimmed = text.replace(STRAY_WRAPPER_TAG, "").trim();
    if (trimmed === "" || trimmed.includes(SILENCE_TOKEN)) return [];
    const bursts: string[] = [];
    let fence: string[] | undefined;
    for (const line of trimmed.split("\n")) {
        const isFenceMarker = line.trimStart().startsWith("```");
        if (fence) {
            fence.push(line);
            if (isFenceMarker) {
                bursts.push(fence.join("\n"));
                fence = undefined;
            }
        } else if (isFenceMarker) {
            fence = [line];
        } else if (line.trim() !== "") {
            bursts.push(line.trim());
        }
    }
    if (fence) bursts.push(fence.join("\n"));
    return bursts.slice(0, MAX_BURSTS);
}

/** Counts lines that look like code, whether or not the model fenced them. */
export function exceedsCodeLimit(bursts: readonly string[], maxCodeLines: number): boolean {
    return bursts.some((burst) => burst.startsWith("```") && burst.split("\n").length - 2 > maxCodeLines);
}
