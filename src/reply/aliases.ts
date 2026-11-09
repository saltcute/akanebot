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
    return people.entries().flatMap((entry) =>
        (entry.aliases ?? []).flatMap((alias) => {
            const lowered = alias.toLowerCase();
            const borrowed = heard.some((message) => message.sender.displayName.toLowerCase() === lowered && !entry.ids.includes(userKey(message)));
            return !borrowed && texts.some((text) => appearsIn(text, lowered)) ? [{ name: alias, description: `a nickname for ${entry.name}` }] : [];
        }),
    );
}
