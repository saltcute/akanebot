import sharp from "sharp";
import type { InlineImage } from "./shrink.ts";

/** An animation laid out as a few of its frames in one picture, since a model only ever takes a still one. */
export type FrameSheet = { sheet: InlineImage; frames: number; seconds: number };

export const MAX_SHEET_FRAMES = 6;
const WEBP_QUALITY = 80;
const GAP = 4;
// Browsers play a frame with no delay, or one this short, for 100ms, so that's how long it lasts.
const SHORTEST_DELAY_MS = 10;
const DEFAULT_DELAY_MS = 100;

/** How long each frame shows for, in milliseconds. */
function frameDelays(pages: number, delay: readonly number[] | undefined): number[] {
    return Array.from({ length: pages }, (_, index) => {
        const ms = delay?.[index] ?? 0;
        return ms > SHORTEST_DELAY_MS ? ms : DEFAULT_DELAY_MS;
    });
}

/**
 * Which frames to show: spread evenly over the time it plays rather than over its frames, so a long pause counts for its
 * length. Always the first and the last.
 */
export function pickFrames(delays: readonly number[], count: number): number[] {
    if (delays.length === 0 || count <= 0) return [];
    if (count === 1) return [0];
    const starts: number[] = [];
    let total = 0;
    for (const ms of delays) {
        starts.push(total);
        total += ms;
    }
    const last = delays.length - 1;
    const picked = Array.from({ length: count }, (_, step) => {
        const time = (total * step) / (count - 1);
        const index = starts.findLastIndex((start) => start <= time);
        return Math.min(Math.max(index, 0), last);
    });
    return [...new Set(picked)];
}

/** Columns and rows for `count` frames, as square as it gets: 2 side by side, 4 as 2 by 2, 6 as 3 by 2. */
export function sheetGrid(count: number): { columns: number; rows: number } {
    const columns = Math.ceil(Math.sqrt(count));
    return { columns, rows: Math.ceil(count / columns) };
}

/**
 * Up to `maxFrames` frames of an animation in a grid that fits inside `maxEdge`, read left to right and top to bottom.
 * Only the frames shown are decoded, so a GIF with thousands of them costs no more than one with six. Undefined for
 * anything that isn't an animation or can't be decoded.
 */
export async function frameSheet(bytes: Uint8Array, maxEdge: number, maxFrames = MAX_SHEET_FRAMES): Promise<FrameSheet | undefined> {
    try {
        const { pages = 1, width, pageHeight, height, delay } = await sharp(bytes).metadata();
        const frameHeight = pageHeight ?? height;
        if (pages < 2 || !width || !frameHeight) return undefined;
        const delays = frameDelays(pages, delay);
        const picked = pickFrames(delays, Math.min(pages, maxFrames));
        const { columns, rows } = sheetGrid(picked.length);
        const scale = Math.min((maxEdge - GAP * (columns - 1)) / columns / width, (maxEdge - GAP * (rows - 1)) / rows / frameHeight, 1);
        const cellWidth = Math.max(1, Math.floor(width * scale));
        const cellHeight = Math.max(1, Math.floor(frameHeight * scale));
        const cells = await Promise.all(
            picked.map((page) => sharp(bytes, { page }).resize({ width: cellWidth, height: cellHeight, fit: "fill" }).png().toBuffer()),
        );
        const sheet = await sharp({
            create: {
                width: columns * cellWidth + GAP * (columns - 1),
                height: rows * cellHeight + GAP * (rows - 1),
                channels: 3,
                background: "#ffffff",
            },
        })
            .composite(
                cells.map((input, index) => ({
                    input,
                    left: (index % columns) * (cellWidth + GAP),
                    top: Math.floor(index / columns) * (cellHeight + GAP),
                })),
            )
            .webp({ quality: WEBP_QUALITY })
            .toBuffer();
        const seconds = Math.round(delays.reduce((sum, ms) => sum + ms, 0) / 100) / 10;
        return { sheet: { data: sheet.toString("base64"), mediaType: "image/webp" }, frames: picked.length, seconds };
    } catch {
        return undefined;
    }
}
