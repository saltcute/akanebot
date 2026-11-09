import { act, api, count, dialog, el, hooks, openDialog, renderEvents, toast } from "./ui.js";

export function showDecisions(messageId) {
    return act(async () => {
        const { decisions } = await api(`/messages/${encodeURIComponent(messageId)}/decisions`);
        openDialog(
            el("h2", {}, "Why she did what she did"),
            decisions.length === 0 ? el("p", {}, "Nothing recorded for this message since the bot last started.") : renderEvents(decisions),
        );
    });
}

export function showPerson(key) {
    return act(async () => {
        const person = await api(`/people/${encodeURIComponent(key)}`);
        const forget = () => {
            if (!confirm(`Permanently delete everything about ${person.displayName}? This can't be undone.`)) return;
            act(async () => {
                const { forgotten } = await api(`/people/${encodeURIComponent(key)}`, { method: "DELETE" });
                dialog.close();
                await hooks.afterPersonGone();
                toast(`Forgot ${count(forgotten, "memory", "memories")}`);
            });
        };
        openDialog(
            el("h2", {}, person.displayName),
            el("p", { className: "meta" }, person.key),
            el(
                "p",
                {},
                `She has ${count(person.memories, "memory", "memories")} and ${count(person.messages, "logged message", "logged messages")} tied to this person. Forgetting deletes all of them, along with how she feels about them.`,
            ),
            el(
                "p",
                { className: "meta" },
                "She can still learn about them from new messages. To stop that, they can send the opt-out command in chat.",
            ),
            el("div", { className: "actions" }, el("button", { className: "danger", onclick: forget }, "Forget this person")),
        );
    });
}
