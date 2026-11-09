import type { ChatMessage } from "../adapters/types.ts";
import { isAddressed } from "../perception/channel.ts";

const MIN_PEOPLE = 2;
const MAX_REPEAT_CHARS = 40;

/**
 * Whether a line can be sent again word for word. Repeats skip the reply model, so this is what keeps
 * media placeholders, pings, links and other bots' commands from going out in the persona's voice.
 */
function canBeRepeated(text: string): boolean {
    if (text === "" || text.length > MAX_REPEAT_CHARS) return false;
    return !/[[\]\r\n@]|:\/\/|^[/!！.。#]/.test(text);
}

/** The line the chat is currently passing around, if at least two people have sent it in a row and the agent hasn't joined in. */
export function findRepeatChain(window: readonly ChatMessage[]): string | undefined {
    const spoken = window.filter((message) => message.groupEvent === undefined);
    const text = spoken.at(-1)?.text.trim();
    if (text === undefined || !canBeRepeated(text)) return undefined;
    const people = new Set<string>();
    for (const message of spoken.toReversed()) {
        if (message.text.trim() !== text) break;
        if (message.isSelf || message.images?.length || isAddressed(message)) return undefined;
        // Bots can extend a chain but not start one, or two of them could set it off.
        if (!message.sender.isBot) people.add(message.sender.id);
    }
    return people.size >= MIN_PEOPLE ? text : undefined;
}
