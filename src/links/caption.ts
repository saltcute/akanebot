import type { LinkReading } from "./sites.ts";

export const LINK_CAPTION_PREFIX = "[link:";
const MAX_CAPTION_CHARS = 240;
/** Said in place of a sexual or graphically violent page, the way a picture like that is. */
const EXPLICIT_PAGE = "something inappropriate that you clicked away from, so you don't know what it says";

/**
 * Keeps a page's words from forging a chat line, closing the placeholder, or carrying an address she could paste back.
 * Brackets and angle brackets go, as in a picture's description, and so does anything that looks like a link.
 */
function clean(text: string | undefined): string {
    return (text ?? "")
        .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
        .replace(/[\r\n[\]<>]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** What replaces a link in the text once she's opened it: where it was, and what she took in. */
export function linkCaption(host: string, reading: LinkReading): string {
    const site = clean(host);
    if (reading.explicit) return `${LINK_CAPTION_PREFIX} ${site} · ${EXPLICIT_PAGE}]`;
    const head = [site, clean(reading.title), clean(reading.by)].filter(Boolean).join(" · ");
    const gist = clean(reading.gist);
    const body = gist ? `${head} — ${gist}` : head;
    const room = MAX_CAPTION_CHARS - LINK_CAPTION_PREFIX.length - 2;
    return `${LINK_CAPTION_PREFIX} ${body.length > room ? `${body.slice(0, room - 1).trimEnd()}…` : body}]`;
}
