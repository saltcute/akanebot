/** A link as it appears in a message, with where it sits so it can be swapped for what she read there. */
export type FoundLink = { url: string; start: number; end: number };

/** Characters a URL can hold. Anything else ends it, which matters in Chinese chat, where text often runs straight on after a link. */
const LINK = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+/gi;
const TRAILING = /[.,;:!?'"*]+$/;

/** Drops punctuation a sentence put after the link, and a closing parenthesis the link never opened. */
function trimEnd(url: string): string {
    let trimmed = url.replace(TRAILING, "");
    while (trimmed.endsWith(")") && (trimmed.match(/\(/g) ?? []).length < (trimmed.match(/\)/g) ?? []).length) {
        trimmed = trimmed.slice(0, -1).replace(TRAILING, "");
    }
    return trimmed;
}

export function findLinks(text: string): FoundLink[] {
    return [...text.matchAll(LINK)].flatMap((match) => {
        const url = trimEnd(match[0]);
        return /^https?:\/\/[^/?#]+/i.test(url) ? [{ url, start: match.index, end: match.index + url.length }] : [];
    });
}
