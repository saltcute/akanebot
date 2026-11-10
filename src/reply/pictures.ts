import type { ChatImage, ChatMessage } from "../adapters/types.ts";

/** A picture shown to the reply model itself. `number` is how the transcript and the attached image refer to each other. */
export type ShownPicture = { messageId: string; number: number; image: ChatImage };

/**
 * Which pictures she looks at again while writing a reply. A description only says what one glance caught, so it can't
 * answer a question about a detail, or show that two pictures are alike.
 *
 * Pictures cost far more than text, so she looks only when a new message posts one or replies to one, or the gate says the
 * talk is about one. Then the earlier ones still in view come along up to `max`, since comparing them is often the point.
 * Only pictures she already looked at count, and only while their message is in view.
 */
export function choosePictures(window: readonly ChatMessage[], firstNewIndex: number, aboutPicture: boolean, max: number): ShownPicture[] {
    if (max <= 0) return [];
    const fresh = window.slice(firstNewIndex).filter((message) => !message.isSelf);
    const wanted = new Set(fresh.flatMap(({ messageId, replyToMessageId }) => [messageId, ...(replyToMessageId ? [replyToMessageId] : [])]));
    const inView = window.filter((message) => message.seenImage && !message.isSelf).toReversed();
    const called = inView.filter(({ messageId }) => wanted.has(messageId));
    if (called.length === 0 && !aboutPicture) return [];
    const chosen = new Set([...called, ...inView.filter(({ messageId }) => !wanted.has(messageId))].slice(0, max));
    return window
        .filter((message) => chosen.has(message))
        .flatMap(({ messageId, seenImage }) => (seenImage ? [{ messageId, image: seenImage }] : []))
        .map((picture, index) => ({ ...picture, number: index + 1 }));
}

/** Written just before each attached picture. */
export function pictureLabel(number: number, animated = false): string {
    return animated ? `Picture ${number} (the first frame of an animated GIF, which is all you can see):` : `Picture ${number}:`;
}
