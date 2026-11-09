import { showDecisions } from "./dialogs.js";
import { act, api, el, formatTime, pill } from "./ui.js";

const activity = { events: [], kinds: [], channels: [], filters: { kind: "", channel: "" } };

async function load() {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(activity.filters)) if (value) query.set(name, value);
    Object.assign(activity, await api(`/trace?${query}`));
}

function renderEvent(event) {
    const hasDetail = event.detail && Object.keys(event.detail).length > 0;
    return el(
        "div",
        { className: "event" },
        el(
            "div",
            { className: "message-head" },
            pill(event.kind, event.kind === "alert" ? "danger" : "accent"),
            el("time", { dateTime: new Date(event.at).toISOString() }, formatTime(event.at)),
            event.channelName ? el("span", { className: "row-time" }, event.channelName) : undefined,
            event.messageId ? el("button", { className: "why", onclick: () => showDecisions(event.messageId) }, "Why?") : undefined,
        ),
        hasDetail ? el("pre", {}, JSON.stringify(event.detail, null, 2)) : undefined,
    );
}

function reload() {
    return act(async () => {
        await load();
        render();
    });
}

function render() {
    const view = document.getElementById("view");
    if (!view) return;
    const select = (name, label, anyLabel, options) =>
        el(
            "select",
            {
                "aria-label": label,
                onchange: (event) => {
                    activity.filters[name] = event.target.value;
                    reload();
                },
            },
            [["", anyLabel], ...options].map(([value, text]) => el("option", { value, selected: activity.filters[name] === value }, text)),
        );
    view.className = "split one-pane";
    view.replaceChildren(
        el(
            "section",
            { className: "pane", "aria-label": "Activity" },
            el(
                "div",
                { className: "toolbar" },
                select(
                    "kind",
                    "Kind",
                    "Every kind",
                    activity.kinds.map((kind) => [kind, kind]),
                ),
                select(
                    "channel",
                    "Conversation",
                    "All conversations",
                    activity.channels.map((channel) => [channel.key, channel.name]),
                ),
                el("button", { onclick: reload }, "Refresh"),
                el("span", { className: "meta" }, "Since the bot last started. Open Why? for the full record of a message."),
            ),
            el(
                "div",
                { className: "scroll" },
                activity.events.length === 0
                    ? el("div", { className: "empty" }, "Nothing recorded yet.")
                    : el("div", { className: "event-list" }, activity.events.map(renderEvent)),
            ),
        ),
    );
}

export const activityTab = { label: "Activity", load, render };
