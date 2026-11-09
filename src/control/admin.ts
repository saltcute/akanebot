import type { ChatMessage } from "../adapters/types.ts";
import { channelKey } from "../adapters/types.ts";
import type { ControlState } from "./state.ts";
import { userKey } from "./state.ts";

export type CommandResult =
    | { handled: false }
    | {
          handled: true;
          /** Plain confirmation for the chat. Absent means say nothing. */
          ack?: string;
          /** Admin commands must be acknowledged even when rate limits would block a normal message. */
          urgent: boolean;
          bodyEffect?: "stop" | "resume";
          /** This person opted out, so everything derived from them must go. */
          forgetUser?: string;
      };

const DEFAULT_MUTE_MINUTES = 60;
export const MAX_MUTE_MINUTES = 10_080;

/** Identity comes from the platform's sender ID. Display names are never trusted here. */
export function runCommand(message: ChatMessage, options: { prefix: string; admins: readonly string[]; state: ControlState }): CommandResult {
    const [prefix, command, argument] = message.text.trim().split(/\s+/);
    if (prefix !== options.prefix) return { handled: false };
    const { state } = options;
    const user = userKey(message);

    if (command === "opt-out") {
        state.optOut(user);
        return {
            handled: true,
            urgent: false,
            forgetUser: user,
            ack: "[akanebot] Done. It has forgotten you and will no longer read your messages.",
        };
    }
    if (command === "opt-in") {
        state.optIn(user);
        return { handled: true, urgent: false, ack: "[akanebot] Done. It can see your messages again." };
    }

    if (!options.admins.includes(user)) return { handled: true, urgent: false };
    const channel = channelKey(message);
    switch (command) {
        case "kill":
            state.setKilled(true);
            return { handled: true, urgent: true, ack: "[akanebot] Stopped everywhere.", bodyEffect: "stop" };
        case "resume":
            state.setKilled(false);
            return { handled: true, urgent: true, ack: "[akanebot] Running again.", bodyEffect: "resume" };
        case "mute": {
            const minutes = argument === undefined ? DEFAULT_MUTE_MINUTES : Number(argument);
            if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MUTE_MINUTES) {
                return { handled: true, urgent: true, ack: `[akanebot] Mute takes minutes, from 1 to ${MAX_MUTE_MINUTES}.` };
            }
            state.mute(channel, minutes * 60_000);
            return { handled: true, urgent: true, ack: `[akanebot] Muted here for ${minutes} min.` };
        }
        case "unmute":
            state.unmute(channel);
            return { handled: true, urgent: true, ack: "[akanebot] Unmuted here." };
        case "status":
            return { handled: true, urgent: true, ack: `[akanebot] killed=${state.killed} muted=${state.isMuted(channel)}` };
        default:
            return { handled: true, urgent: false };
    }
}
