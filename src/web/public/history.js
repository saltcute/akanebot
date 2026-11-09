import { showDecisions, showPerson } from "./dialogs.js";
import { act, api, el, formatTime, PAGE_SIZE, pill, SEARCH_DELAY_MS } from "./ui.js";

const history = { messages: [], total: 0, channels: [], people: [], filters: { q: "", channel: "", user: "" }, offset: 0 };

async function fetchPage() {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(history.offset) });
    for (const [name, value] of Object.entries(history.filters)) if (value) query.set(name, value);
    Object.assign(history, await api(`/history?${query}`));
}

async function load() {
    const [{ people }] = await Promise.all([api("/people"), fetchPage()]);
    history.people = people;
}

function remove(message) {
    if (
        !confirm(
            "Delete this message from her log and what she can see? Memories already made from it stay, and the copy on Discord or QQ isn't touched.",
        )
    )
        return;
    act(async () => {
        await api(`/history/${encodeURIComponent(message.channel)}/${encodeURIComponent(message.messageId)}`, { method: "DELETE" });
        await fetchPage();
        render();
    }, "Deleted");
}

function renderLine(message) {
    return el(
        "article",
        { className: `message${message.isSelf ? " self" : ""}` },
        el(
            "div",
            { className: "message-head" },
            message.isSelf || message.senderKey.endsWith(":event")
                ? el("b", {}, message.senderName)
                : el("button", { className: "link", onclick: () => showPerson(message.senderKey) }, message.senderName),
            el("time", { dateTime: new Date(message.sentAt).toISOString() }, formatTime(message.sentAt)),
            el("span", { className: "row-time" }, message.channelName),
            message.attended ? undefined : pill("Not read"),
            message.digested ? pill("Digested", "ok") : undefined,
            el("button", { className: "why", onclick: () => showDecisions(message.messageId) }, "Why?"),
            el("button", { className: "why", onclick: () => remove(message) }, "Delete"),
        ),
        message.quoted ? el("div", { className: "message-quote" }, el("b", {}, message.quoted.senderName), " ", message.quoted.text) : undefined,
        el("p", { className: "message-text" }, message.text),
    );
}

function renderLines() {
    if (history.messages.length === 0) return el("div", { className: "empty" }, "No messages match.");
    return el("div", { className: "transcript" }, history.messages.map(renderLine));
}

function renderPager() {
    const { total, offset } = history;
    const first = total === 0 ? 0 : offset + 1;
    const last = Math.min(offset + PAGE_SIZE, total);
    const go = (target) =>
        act(async () => {
            history.offset = target;
            await fetchPage();
            render();
        });
    return el(
        "div",
        { className: "pager", id: "history-pager" },
        el("span", {}, `${first}–${last} of ${total}`),
        el(
            "div",
            { className: "actions" },
            el("button", { disabled: offset === 0, onclick: () => go(Math.max(0, offset - PAGE_SIZE)) }, "Newer"),
            el("button", { disabled: last >= total, onclick: () => go(offset + PAGE_SIZE) }, "Older"),
        ),
    );
}

function applyFilter(name, value) {
    return act(async () => {
        history.filters[name] = value;
        history.offset = 0;
        await fetchPage();
        document.getElementById("history-scroll").replaceChildren(renderLines());
        document.getElementById("history-pager").replaceWith(renderPager());
    });
}

let searchTimer;
function renderToolbar() {
    const select = (name, label, options) =>
        el(
            "select",
            { "aria-label": label, onchange: (event) => applyFilter(name, event.target.value) },
            options.map(([value, text]) => el("option", { value, selected: history.filters[name] === value }, text)),
        );
    return el(
        "div",
        { className: "toolbar" },
        el("input", {
            type: "search",
            placeholder: "Search messages",
            "aria-label": "Search messages",
            value: history.filters.q,
            oninput: (event) => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => applyFilter("q", event.target.value.trim()), SEARCH_DELAY_MS);
            },
        }),
        select("channel", "Conversation", [["", "All conversations"], ...history.channels.map((channel) => [channel.key, channel.name])]),
        select("user", "Person", [["", "Everyone"], ...history.people.map((person) => [person.key, person.name])]),
    );
}

function render() {
    const view = document.getElementById("view");
    if (!view) return;
    view.className = "split one-pane";
    view.replaceChildren(
        el(
            "section",
            { className: "pane", "aria-label": "History" },
            renderToolbar(),
            el("div", { className: "scroll", id: "history-scroll" }, renderLines()),
            renderPager(),
        ),
    );
}

export const historyTab = { label: "History", load, render };
