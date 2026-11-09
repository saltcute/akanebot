// Everything shown here can come from strangers in a chat, so text only ever enters the page as text nodes.

import { showDecisions, showPerson } from "./dialogs.js";
import { act, api, count, el, formatTime, hooks, openDialog, PAGE_SIZE, pill, renderEvents, SEARCH_DELAY_MS, session, toast } from "./ui.js";

const POLL_MS = 3000;
const TAB_KEY = "akanebot.tab";
const STICK_TO_BOTTOM_PX = 40;
const MUTE_CHOICES = [
    [15, "15 minutes"],
    [60, "1 hour"],
    [480, "8 hours"],
    [1440, "1 day"],
    [10080, "1 week"],
];
const BODY_STATES = { idle: "Idle", reading: "Reading", composing: "Writing", sending: "Typing", away: "Away" };
const MEMORY_STATES = { active: "Active", archived: "Archived", replaced: "Replaced" };
const MEMORY_KINDS = { episode: "Episode", fact: "Fact", claim: "Claim", event: "Event" };
const MEMORY_REACHES = { group: "This group only", shared: "Shared" };

const root = document.getElementById("root");

const ui = {
    tab: sessionStorage.getItem(TAB_KEY) ?? "conversations",
    status: undefined,
    conversations: [],
    conversationKey: undefined,
    conversation: undefined,
    memories: { memories: [], total: 0, scopes: [] },
    memoryFilters: { q: "", scope: "", kind: "", reach: "", state: "active" },
    memoryOffset: 0,
    memory: undefined,
};

function signOut() {
    session.clear();
    showLogin();
}

hooks.onUnauthorized = signOut;
hooks.afterPersonGone = async () => {
    ui.memory = undefined;
    await TABS[ui.tab].load();
    TABS[ui.tab].render();
};

function conversationTitle(conversation) {
    return conversation.name ?? conversation.key;
}

function showLogin(message) {
    const input = el("input", {
        type: "password",
        autocomplete: "current-password",
        required: true,
        "aria-label": "Access token",
        placeholder: "Access token",
    });
    const form = el(
        "form",
        {
            onsubmit: async (event) => {
                event.preventDefault();
                await signIn(input.value.trim());
            },
        },
        el("h1", {}, "Akanebot Console"),
        el("p", {}, "Paste the token printed when the bot started, or your AKANEBOT_WEB_TOKEN."),
        input,
        message ? el("div", { className: "error" }, message) : undefined,
        el("button", { className: "primary", type: "submit" }, "Sign in"),
    );
    root.replaceChildren(el("div", { className: "login" }, form));
    input.focus();
}

async function signIn(token) {
    session.token = token;
    try {
        const response = await fetch("/api/status", { headers: { authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(response.status === 401 ? "That token isn't right." : "The server didn't respond properly.");
        session.remember(token);
        ui.status = await response.json();
        await TABS[ui.tab].load();
        render();
    } catch (error) {
        session.clear();
        showLogin(error.message);
    }
}

async function refresh() {
    const [status] = await Promise.all([api("/status"), TABS[ui.tab].live ? TABS[ui.tab].load() : undefined]);
    ui.status = status;
}

async function refreshConversations() {
    const { conversations } = await api("/conversations");
    ui.conversations = conversations;
    ui.conversationKey ??= conversations[0]?.key;
    ui.conversation = ui.conversationKey ? await api(`/conversations/${encodeURIComponent(ui.conversationKey)}`) : undefined;
}

async function refreshMemories() {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(ui.memoryOffset) });
    for (const [name, value] of Object.entries(ui.memoryFilters)) if (value) query.set(name, value);
    ui.memories = await api(`/memories?${query}`);
}

async function openMemory(id) {
    ui.memory = await api(`/memories/${id}`);
    renderMemories();
}

async function reloadMemoriesAfterChange(id) {
    await refreshMemories();
    if (id === undefined) ui.memory = undefined;
    else ui.memory = await api(`/memories/${id}`);
    renderMemories();
}

function render() {
    root.replaceChildren(el("div", { className: "app" }, renderTop(), el("div", { id: "banner" }), el("main", { id: "view", className: "split" })));
    renderBanner();
    TABS[ui.tab].render();
}

function renderTop() {
    const tab = ([id, { label }]) =>
        el(
            "button",
            {
                role: "tab",
                "aria-selected": String(ui.tab === id),
                onclick: () =>
                    act(async () => {
                        ui.tab = id;
                        sessionStorage.setItem(TAB_KEY, id);
                        await TABS[id].load();
                        render();
                    }),
            },
            label,
        );
    return el(
        "header",
        { className: "top" },
        el("div", { className: "brand", id: "brand" }, ui.status?.personaName ?? "Akanebot"),
        el("nav", { className: "tabs", role: "tablist" }, Object.entries(TABS).map(tab)),
        el("div", { className: "vitals", id: "vitals" }, renderVitals()),
    );
}

function renderVitals() {
    const status = ui.status;
    if (!status) return [];
    const { spentTodayUsd, dailyBudgetUsd } = status.cost;
    const body = BODY_STATES[status.body] ?? status.body;
    const stat = (label, value) => el("span", {}, `${label} `, el("b", {}, value));
    return [
        stat("Now", status.awayReasons.length > 0 ? `${body} (${status.awayReasons.join(", ")})` : body),
        stat("Battery", `${Math.round(status.battery * 100)}%`),
        stat("Today", `$${spentTodayUsd.toFixed(2)} / $${dailyBudgetUsd.toFixed(2)}`),
        status.shadow ? pill("Shadow, sends nothing", "warn") : pill("Live", "ok"),
        status.alerts.length > 0 ? el("button", { onclick: showAlerts }, `Alerts (${status.alerts.length})`) : undefined,
        status.killed
            ? el("button", { className: "primary", onclick: () => control("resume", "Running again") }, "Resume")
            : el(
                  "button",
                  {
                      className: "danger",
                      onclick: () => {
                          if (confirm("Stop the bot in every channel? It stays connected, and Resume undoes this."))
                              control("kill", "Stopped everywhere");
                      },
                  },
                  "Stop everywhere",
              ),
        el("button", { onclick: signOut }, "Sign out"),
    ].filter(Boolean);
}

function renderBanner() {
    const banner = document.getElementById("banner");
    if (banner)
        banner.replaceChildren(
            ...(ui.status?.killed ? [el("div", { className: "banner" }, "Stopped everywhere. It isn't reading or replying until you resume.")] : []),
        );
}

function updateChrome() {
    const brand = document.getElementById("brand");
    const vitals = document.getElementById("vitals");
    if (brand) brand.textContent = ui.status?.personaName ?? "Akanebot";
    if (vitals) vitals.replaceChildren(...renderVitals());
    renderBanner();
}

function control(action, done) {
    return act(async () => {
        await api(`/control/${action}`, { method: "POST" });
        await refresh();
        updateChrome();
    }, done);
}

function renderConversations() {
    const view = document.getElementById("view");
    if (!view) return;
    view.className = "split";
    const previousLog = document.getElementById("log");
    const stuckToBottom = !previousLog || previousLog.scrollHeight - previousLog.scrollTop - previousLog.clientHeight < STICK_TO_BOTTOM_PX;
    const previousScroll = previousLog?.scrollTop ?? 0;
    const samePane = previousLog?.dataset.key === ui.conversationKey;

    view.replaceChildren(
        el("section", { className: "pane", "aria-label": "Conversations" }, el("div", { className: "scroll" }, renderConversationList())),
        el("section", { className: "pane", "aria-label": "Conversation" }, renderConversationPane()),
    );

    const log = document.getElementById("log");
    if (log) log.scrollTop = !samePane || stuckToBottom ? log.scrollHeight : previousScroll;
}

function renderConversationList() {
    if (ui.conversations.length === 0)
        return el("div", { className: "empty" }, "No channels are allowed yet. Add one under control.groups in the config.");
    return el(
        "ul",
        { className: "rows" },
        ui.conversations.map((conversation) =>
            el(
                "li",
                {},
                el(
                    "button",
                    {
                        className: "row",
                        "aria-current": String(conversation.key === ui.conversationKey),
                        onclick: () =>
                            act(async () => {
                                ui.conversationKey = conversation.key;
                                await refreshConversations();
                                renderConversations();
                            }),
                    },
                    el(
                        "div",
                        { className: "row-head" },
                        el("span", { className: "row-title" }, conversationTitle(conversation)),
                        el("span", { className: "row-time" }, formatTime(conversation.lastMessage?.sentAt)),
                    ),
                    el(
                        "div",
                        { className: "preview" },
                        conversation.lastMessage ? `${conversation.lastMessage.senderName}: ${conversation.lastMessage.text}` : "Nothing yet",
                    ),
                    el("div", { className: "meta" }, conversationBadges(conversation)),
                ),
            ),
        ),
    );
}

function conversationBadges(conversation) {
    return [
        conversation.attending ? pill("Reading now", "accent") : undefined,
        conversation.unread > 0 ? pill(`${conversation.unread} unread`, "accent") : undefined,
        conversation.mutedUntil ? pill(`Muted until ${formatTime(conversation.mutedUntil)}`, "warn") : undefined,
    ];
}

function renderConversationPane() {
    const conversation = ui.conversation;
    if (!conversation) return el("div", { className: "empty" }, "Pick a conversation.");
    const path = `/conversations/${encodeURIComponent(conversation.key)}`;
    const post = (action, body, done) =>
        act(async () => {
            const result = await api(`${path}/${action}`, { method: "POST", ...(body ? { body } : {}) });
            await refreshConversations();
            renderConversations();
            return result;
        }, done);
    const select = el(
        "select",
        { "aria-label": "Mute for" },
        MUTE_CHOICES.map(([minutes, label]) => el("option", { value: String(minutes), selected: minutes === 60 }, label)),
    );
    const digest = () =>
        act(async () => {
            const { undigested } = await api(`${path}/digest`, { method: "POST" });
            await refreshConversations();
            renderConversations();
            toast(undigested === 0 ? "Saved to memory" : "Couldn't finish, so those messages stay queued. Check the alerts.");
        });

    return [
        el(
            "div",
            { className: "toolbar" },
            el("h2", {}, conversationTitle(conversation)),
            conversation.mutedUntil
                ? el("button", { onclick: () => post("unmute", undefined, "Unmuted") }, "Unmute")
                : [select, el("button", { onclick: () => post("mute", { minutes: Number(select.value) }, "Muted") }, "Mute")],
            el(
                "button",
                {
                    disabled: conversation.unread === 0,
                    title: "She won't answer or remember these",
                    onclick: () => post("read", undefined, "Marked as read"),
                },
                conversation.unread > 0 ? `Let go of ${conversation.unread} unread` : "Nothing unread",
            ),
            el(
                "button",
                { disabled: conversation.undigested === 0, title: "Turn what she has read into memories now", onclick: digest },
                conversation.undigested > 0 ? `Save ${conversation.undigested} to memory` : "All saved",
            ),
        ),
        el("div", { className: "scroll", id: "log", "data-key": conversation.key }, renderTranscript(conversation)),
    ];
}

function renderTranscript(conversation) {
    if (conversation.messages.length === 0) return el("div", { className: "empty" }, "Nothing here yet.");
    const lines = [];
    conversation.messages.forEach((message, index) => {
        if (index === conversation.firstNewIndex) lines.push(el("div", { className: "divider" }, "Unread"));
        lines.push(renderMessage(message));
    });
    return el("div", { className: "transcript" }, lines);
}

function renderMessage(message) {
    return el(
        "article",
        { className: `message${message.isSelf ? " self" : ""}${message.isShadow ? " shadow" : ""}${message.addressed ? " addressed" : ""}` },
        el(
            "div",
            { className: "message-head" },
            message.isSelf || message.isEvent
                ? el("b", {}, message.senderName)
                : el("button", { className: "link", onclick: () => showPerson(message.senderKey) }, message.senderName),
            el("time", { dateTime: new Date(message.sentAt).toISOString() }, formatTime(message.sentAt)),
            message.isShadow ? pill("Shadow, not sent", "warn") : undefined,
            message.isShadow ? undefined : el("button", { className: "why", onclick: () => showDecisions(message.messageId) }, "Why?"),
        ),
        message.isReply ? renderQuote(message.quoted) : undefined,
        el("p", { className: "message-text" }, message.text),
        message.reactions.length > 0
            ? el(
                  "div",
                  { className: "reactions" },
                  message.reactions.map((reaction) => pill(`${reaction.emoji} ${reaction.by}`)),
              )
            : undefined,
    );
}

function renderQuote(quoted) {
    if (!quoted) return el("div", { className: "message-quote" }, "Replying to an earlier message");
    return el("div", { className: "message-quote" }, el("b", {}, quoted.senderName), " ", quoted.text);
}

function renderMemories() {
    const view = document.getElementById("view");
    if (!view) return;
    const listScroll = document.getElementById("memory-scroll")?.scrollTop ?? 0;
    view.className = "split wide-list";
    view.replaceChildren(
        el(
            "section",
            { className: "pane", "aria-label": "Memories" },
            renderMemoryFilters(),
            el("div", { className: "scroll", id: "memory-scroll" }, renderMemoryList()),
            renderPager(),
        ),
        el("section", { className: "pane", "aria-label": "Memory" }, el("div", { className: "scroll" }, renderMemoryDetail())),
    );
    document.getElementById("memory-scroll").scrollTop = listScroll;
}

let searchTimer;
function renderMemoryFilters() {
    const applyFilter = (name, value) =>
        act(async () => {
            ui.memoryFilters[name] = value;
            ui.memoryOffset = 0;
            await refreshMemories();
            document.getElementById("memory-list").replaceChildren(renderMemoryRows());
            document.getElementById("memory-pager").replaceWith(renderPager());
        });
    const filterSelect = (name, label, options) =>
        el(
            "select",
            { "aria-label": label, onchange: (event) => applyFilter(name, event.target.value) },
            options.map(([value, text]) => el("option", { value, selected: ui.memoryFilters[name] === value }, text)),
        );
    return el(
        "div",
        { className: "toolbar" },
        el("input", {
            type: "search",
            placeholder: "Search memories",
            "aria-label": "Search memories",
            value: ui.memoryFilters.q,
            oninput: (event) => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => applyFilter("q", event.target.value.trim()), SEARCH_DELAY_MS);
            },
        }),
        filterSelect("state", "State", [...Object.entries(MEMORY_STATES), ["", "Any state"]]),
        filterSelect("kind", "Kind", [["", "Any kind"], ...Object.entries(MEMORY_KINDS)]),
        filterSelect("reach", "Reach", [["", "Any reach"], ...Object.entries(MEMORY_REACHES)]),
        filterSelect("scope", "Conversation", [["", "All conversations"], ...ui.memories.scopes.map((scope) => [scope.key, scope.name])]),
    );
}

function renderMemoryList() {
    return el("div", { id: "memory-list" }, renderMemoryRows());
}

function memoryState(memory) {
    if (memory.supersededBy !== null) return "replaced";
    return memory.status;
}

function renderMemoryRows() {
    if (ui.memories.memories.length === 0) return el("div", { className: "empty" }, "No memories match.");
    return el(
        "ul",
        { className: "rows" },
        ui.memories.memories.map((memory) =>
            el(
                "li",
                {},
                el(
                    "button",
                    { className: "row", "aria-current": String(memory.id === ui.memory?.id), onclick: () => act(() => openMemory(memory.id)) },
                    el("p", { className: "gist" }, memory.gist),
                    el(
                        "div",
                        { className: "meta" },
                        pill(MEMORY_KINDS[memory.kind] ?? memory.kind, "accent"),
                        memory.reach === "shared" ? pill(MEMORY_REACHES.shared, "ok") : undefined,
                        memoryState(memory) === "active" ? undefined : pill(MEMORY_STATES[memoryState(memory)], "warn"),
                        el("span", {}, memory.scopeName),
                        el("span", {}, formatTime(memory.createdAt)),
                    ),
                ),
            ),
        ),
    );
}

function renderPager() {
    const { total } = ui.memories;
    const first = total === 0 ? 0 : ui.memoryOffset + 1;
    const last = Math.min(ui.memoryOffset + PAGE_SIZE, total);
    const go = (offset) =>
        act(async () => {
            ui.memoryOffset = offset;
            await refreshMemories();
            renderMemories();
        });
    return el(
        "div",
        { className: "pager", id: "memory-pager" },
        el("span", {}, `${first}–${last} of ${total}`),
        el(
            "div",
            { className: "actions" },
            el("button", { disabled: ui.memoryOffset === 0, onclick: () => go(Math.max(0, ui.memoryOffset - PAGE_SIZE)) }, "Newer"),
            el("button", { disabled: last >= total, onclick: () => go(ui.memoryOffset + PAGE_SIZE) }, "Older"),
        ),
    );
}

function renderMemoryDetail() {
    const memory = ui.memory;
    if (!memory) return el("div", { className: "empty" }, "Pick a memory to read or change it.");
    const path = `/memories/${memory.id}`;
    const gist = el("textarea", { rows: 3, value: memory.gist, required: true, maxLength: 4000 });
    const detail = el("textarea", { rows: 5, value: memory.detail, maxLength: 20000 });
    const importanceValue = el("output", {}, memory.importance.toFixed(2));
    const importance = el("input", {
        type: "range",
        min: "0",
        max: "1",
        step: "0.05",
        value: String(memory.importance),
        "aria-label": "Importance",
        oninput: () => {
            importanceValue.textContent = Number(importance.value).toFixed(2);
        },
    });
    const state = memoryState(memory);
    const save = () =>
        act(async () => {
            await api(path, { method: "PATCH", body: { gist: gist.value, detail: detail.value, importance: Number(importance.value) } });
            await reloadMemoriesAfterChange(memory.id);
        }, "Saved");
    const change = (action, done) =>
        act(async () => {
            await api(`${path}/${action}`, { method: "POST" });
            await reloadMemoriesAfterChange(memory.id);
        }, done);
    const setReach = (reach) => () =>
        act(async () => {
            await api(`${path}/reach`, { method: "POST", body: { reach } });
            await reloadMemoriesAfterChange(memory.id);
        }, MEMORY_REACHES[reach]);
    const remove = () => {
        if (!confirm("Delete this memory for good? Archive is the option you can undo.")) return;
        act(async () => {
            await api(path, { method: "DELETE" });
            await reloadMemoriesAfterChange(undefined);
        }, "Deleted");
    };
    const person = (key, name) =>
        key?.includes(":") && !key.startsWith("name:") && !key.endsWith(":self")
            ? el("button", { className: "link", onclick: () => showPerson(key) }, name)
            : name;
    const fact = (label, value) => [el("dt", {}, label), el("dd", {}, value)];

    return el(
        "div",
        { className: "detail" },
        el(
            "div",
            { className: "meta" },
            pill(MEMORY_KINDS[memory.kind] ?? memory.kind, "accent"),
            pill(MEMORY_STATES[state], state === "active" ? "ok" : "warn"),
            pill(MEMORY_REACHES[memory.reach] ?? memory.reach, memory.reach === "shared" ? "ok" : ""),
            el("span", {}, `#${memory.id} in ${memory.scopeName}`),
        ),
        el("label", { className: "field" }, "What she remembers", gist),
        el("label", { className: "field" }, "Details", detail),
        el(
            "div",
            { className: "field" },
            el("label", { className: "field" }, "Importance", el("div", { className: "range" }, importance, importanceValue)),
        ),
        el(
            "div",
            { className: "actions" },
            el("button", { className: "primary", onclick: save }, "Save"),
            memory.shareable || memory.reach === "shared"
                ? el(
                      "button",
                      { onclick: setReach(memory.reach === "shared" ? "group" : "shared") },
                      memory.reach === "shared" ? "Keep in this group" : "Share with other groups",
                  )
                : undefined,
            state === "active"
                ? el("button", { onclick: () => change("archive", "Archived") }, "Archive")
                : el("button", { onclick: () => change("restore", "Restored") }, "Restore"),
            el("button", { className: "danger push", onclick: remove }, "Delete"),
        ),
        el(
            "dl",
            { className: "facts" },
            fact("About", person(memory.subject, memory.subjectName ?? "Nobody in particular")),
            memory.attributedTo ? fact("Said by", person(memory.attributedTo, memory.attributedToName)) : undefined,
            fact("Created", formatTime(memory.createdAt)),
            fact(
                "Recalled",
                `${count(memory.recallCount, "time", "times")}${memory.lastRecalledAt ? `, last ${formatTime(memory.lastRecalledAt)}` : ""}`,
            ),
            fact("Confidence", memory.confidence.toFixed(2)),
            fact("Strength", memory.strength.toFixed(2)),
            fact("Emotion", memory.salience.toFixed(2)),
            fact("Search index", memory.indexed ? "Up to date" : "Not indexed, so only keyword matches find it"),
            memory.supersededBy === null ? undefined : fact("Replaced by", `#${memory.supersededBy}`),
        ),
        el("h3", {}, `Came from (${memory.sources.length})`),
        memory.sources.length === 0
            ? el("div", { className: "meta" }, "No source messages recorded.")
            : memory.sources.map((source) =>
                  el(
                      "div",
                      { className: "source" },
                      person(source.speaker, source.displayName),
                      source.sentAt === null ? undefined : el("span", { className: "row-time" }, ` ${formatTime(source.sentAt)}`),
                      el("p", {}, source.text ?? "(the original message has expired)"),
                  ),
              ),
    );
}

function showAlerts() {
    openDialog(el("h2", {}, "Recent alerts"), renderEvents([...(ui.status?.alerts ?? [])].reverse()));
}

async function poll() {
    if (!session.token || document.hidden || !document.getElementById("view")) return;
    try {
        const tab = TABS[ui.tab];
        const previous = tab.live?.();
        await refresh();
        updateChrome();
        // Redrawing only on change keeps text selection and open dropdowns intact.
        if (tab.live && tab.live() !== previous) tab.render();
    } catch {
        // The next poll tries again. A dropped connection shouldn't throw up an error every few seconds.
    }
}

/** Each tab says how to fetch and draw itself. `live` is for tabs that follow the bot: it returns what a redraw would depend on. */
const TABS = {
    conversations: {
        label: "Conversations",
        load: refreshConversations,
        render: renderConversations,
        live: () => JSON.stringify([ui.conversations, ui.conversation]),
    },
    memories: { label: "Memories", load: refreshMemories, render: renderMemories },
};

function start() {
    if (!Object.hasOwn(TABS, ui.tab)) ui.tab = "conversations";
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("token");
    if (fromLink) {
        // Kept out of the address bar and browser history once it has been read.
        history.replaceState(null, "", location.pathname);
        signIn(fromLink);
    } else if (session.token) {
        signIn(session.token);
    } else {
        showLogin();
    }
    setInterval(poll, POLL_MS);
}

start();
