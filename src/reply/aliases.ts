import type { ChatMessage } from "../adapters/types.ts";
import type { People } from "../control/people.ts";
import { userKey } from "../control/state.ts";
import type { Recalled } from "../memory/recall.ts";
import { runsTogether } from "./mentions.ts";

function appearsIn(text: string, alias: string): boolean {
    for (let at = text.indexOf(alias); at !== -1; at = text.indexOf(alias, at + 1)) {
        if (!runsTogether(text[at - 1], alias[0]) && !runsTogether(alias.at(-1), text[at + alias.length])) return true;
    }
    return false;
}

/** Shorter than this and a name turns up inside ordinary words. The operator's aliases have the same floor. */
const SHORTEST_NAME = 2;

/**
 * A group shows the name someone set for it, but anyone can open their profile and see the account's own name, so people get called by either.
 * Only for people in this window, and never one that somebody else here is using.
 */
function accountNames(people: People, heard: readonly ChatMessage[]): { name: string; owner: string; description: string }[] {
    const speakers = [...new Map(heard.filter(({ sender }) => !sender.isBot).map((message) => [userKey(message), message.sender])).entries()];
    return speakers.flatMap(([user, sender]) => {
        const name = sender.accountName;
        if (name === undefined || name.length < SHORTEST_NAME) return [];
        const lowered = name.toLowerCase();
        if (lowered === sender.displayName.toLowerCase()) return [];
        const owner = people.personOf(user);
        const shared = speakers.some(
            ([other, { displayName, accountName }]) =>
                people.personOf(other) !== owner && [displayName, accountName].some((used) => used?.toLowerCase() === lowered),
        );
        return shared ? [] : [{ name, owner, description: `another name for ${people.nameOf(user) ?? sender.displayName}` }];
    });
}

/**
 * Explains the nicknames in what it's about to read, so the operator's list never goes into the prompt whole.
 * Only says what a name means, never who is talking: display names don't count, and an alias someone else is wearing in this window is left out.
 */
export function explainAliases(
    people: People,
    window: readonly ChatMessage[],
    recalled: readonly Recalled[],
): { name: string; description: string }[] {
    const heard = window.filter(({ groupEvent, isSelf }) => !groupEvent && !isSelf);
    const memories = recalled.map(({ memory, detailed }) => (detailed && memory.detail ? `${memory.gist} ${memory.detail}` : memory.gist));
    const texts = [...heard.map(({ text }) => text), ...memories].map((text) => text.toLowerCase());
    const isMentioned = (name: string) => texts.some((text) => appearsIn(text, name.toLowerCase()));
    const configured = people.entries().flatMap((entry) =>
        (entry.aliases ?? []).flatMap((alias) => {
            const lowered = alias.toLowerCase();
            const borrowed = heard.some((message) => message.sender.displayName.toLowerCase() === lowered && !entry.ids.includes(userKey(message)));
            return !borrowed && isMentioned(alias) ? [{ name: alias, description: `a nickname for ${entry.name}` }] : [];
        }),
    );
    // What the operator wrote down wins over a name anyone can set for themselves.
    const taken = new Set(people.entries().flatMap((entry) => [entry.name, ...(entry.aliases ?? [])].map((name) => name.toLowerCase())));
    const observed = accountNames(people, heard)
        .filter(({ name }) => !taken.has(name.toLowerCase()) && isMentioned(name))
        .map(({ name, description }) => ({ name, description }));
    return [...configured, ...observed];
}
