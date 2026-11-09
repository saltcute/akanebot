import { OWN_IMAGE_PREFIX, OWN_REACTION_PREFIX } from "./prompt.ts";

const MAX_BURSTS = 4;
/** Reasoning a model sometimes emits as a tagged block, removed along with its contents. */
const REASONING_BLOCK = /<(thinking[\w-]*|reasoning|analysis)>[\s\S]*?<\/\1>/gi;
/** Models sometimes echo the transcript's tag style around a reply. Only these names, so HTML in code answers survives. */
const STRAY_WRAPPER_TAG = /<\/?(?:chat[\w-]*|reply|response|message|output)>/gi;

/** Turns the model's list into chat messages: cleaned, capped, and with lines split unless they are fenced code. */
export function toBursts(messages: readonly string[], maxBursts = MAX_BURSTS): string[] {
    // The model sometimes imitates the transcript's record of a reaction or a picture. That's not something to say out loud.
    return messages
        .flatMap(splitLines)
        .filter((burst) => !burst.startsWith(OWN_REACTION_PREFIX) && !burst.startsWith(OWN_IMAGE_PREFIX))
        .slice(0, maxBursts);
}

function splitLines(text: string): string[] {
    const trimmed = text.replace(REASONING_BLOCK, "").replace(STRAY_WRAPPER_TAG, "").trim();
    if (trimmed === "") return [];
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
    return bursts;
}

/** Counts the lines inside a fenced code block. */
export function exceedsCodeLimit(bursts: readonly string[], maxCodeLines: number): boolean {
    return bursts.some((burst) => burst.startsWith("```") && burst.split("\n").length - 2 > maxCodeLines);
}
