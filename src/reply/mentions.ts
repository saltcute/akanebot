import type { ChatMessage, OutgoingMention } from "../adapters/types.ts";
import { sanitizeName } from "./prompt.ts";

export type Mentionable = { name: string; userId: string };
export type ResolvedBurst = { text: string; mention?: OutgoingMention };

/** Characters that run together into one word, unlike Chinese, where a name is often followed directly by the next word. */
const WORD_CHARACTER = /[\p{Script=Latin}\p{N}_]/u;

/**
 * Who it may notify: people actively in this conversation, by the names the model was shown, so nobody can get it to ping a bystander.
 * Bots are left out because a ping can set them off, and a name two people share is left out because it can't say which one is meant.
 */
export function mentionablePeople(window: readonly ChatMessage[]): Mentionable[] {
    const idsByName = new Map<string, Set<string>>();
    for (const { groupEvent, isSelf, sender } of window) {
        if (groupEvent || isSelf || sender.isBot) continue;
        const name = sanitizeName(sender.displayName);
        idsByName.set(name, (idsByName.get(name) ?? new Set()).add(sender.id));
    }
    return [...idsByName]
        .flatMap(([name, ids]) => (ids.size === 1 ? [{ name, userId: [...ids][0] as string }] : []))
        .sort((a, b) => b.name.length - a.name.length);
}

function runsTogether(left: string | undefined, right: string | undefined): boolean {
    return left !== undefined && right !== undefined && WORD_CHARACTER.test(left) && WORD_CHARACTER.test(right);
}

function personAt(text: string, at: number, people: readonly Mentionable[]): Mentionable | undefined {
    return people.find(
        ({ name }) => text.startsWith(name, at + 1) && !runsTogether(text[at - 1], name[0]) && !runsTogether(name.at(-1), text[at + 1 + name.length]),
    );
}

function resolveBurst(burst: string, people: readonly Mentionable[], mayPing: boolean): ResolvedBurst {
    let text = "";
    let copied = 0;
    let mention: OutgoingMention | undefined;
    for (let at = burst.indexOf("@"); at !== -1; at = burst.indexOf("@", at + 1)) {
        const person = personAt(burst, at, people);
        if (!person) continue;
        text += burst.slice(copied, at);
        copied = at + 1;
        if (mayPing && !mention) {
            mention = { userId: person.userId, start: text.length, end: text.length + 1 + person.name.length };
            text += "@";
        }
    }
    text += burst.slice(copied);
    return mention ? { text, mention } : { text };
}

/** The model only ever writes `@name`, and code decides what that becomes. The first one in a reply notifies someone and the rest turn into plain names. */
export function resolveMentions(bursts: readonly string[], people: readonly Mentionable[]): ResolvedBurst[] {
    let pinged = false;
    return bursts.map((burst) => {
        if (burst.startsWith("```")) return { text: burst };
        const resolved = resolveBurst(burst, people, !pinged);
        pinged ||= resolved.mention !== undefined;
        return resolved;
    });
}
