import type { ChatMessage } from "../adapters/types.ts";
import type { ImageLook } from "./look.ts";

export type KeepVerdict = "keep" | "not_theirs" | "sensitive" | "not_reaction" | "not_interested";

/** She only collects reaction pictures she actually likes, posted by the person whose picture it is. */
export function judgeImage(look: ImageLook, message: ChatMessage, pickiness: number): KeepVerdict {
    // A forward can't be tied to whoever made it, so nobody could opt it back out.
    if (message.sender.isBot || message.forwarded) return "not_theirs";
    if (look.sensitive) return "sensitive";
    if (!look.reactionImage || look.useFor === "") return "not_reaction";
    return look.appeal >= pickiness ? "keep" : "not_interested";
}
