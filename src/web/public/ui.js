// Everything shown here can come from strangers in a chat, so text only ever enters the page as text nodes.

const TOKEN_KEY = "akanebot.token";
const TOAST_MS = 3500;
export const BODY_STATES = { idle: "Idle", reading: "Reading", composing: "Writing", sending: "Typing", away: "Away" };
export const PAGE_SIZE = 50;
export const SEARCH_DELAY_MS = 250;

const toastBox = document.getElementById("toast");
export const dialog = document.getElementById("dialog");

export const session = {
    token: sessionStorage.getItem(TOKEN_KEY) ?? "",
    remember(token) {
        session.token = token;
        sessionStorage.setItem(TOKEN_KEY, token);
    },
    clear() {
        session.token = "";
        sessionStorage.removeItem(TOKEN_KEY);
    },
};

/** Set by the page shell, so a view can ask for things only the shell knows how to do. */
export const hooks = {
    onUnauthorized: () => {},
    afterPersonGone: async () => {},
};

/** Builds an element. Children are always appended as nodes or text, never parsed as markup. */
export function el(tag, properties = {}, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(properties)) {
        if (value === undefined) continue;
        if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
        else if (name in element && name !== "list") element[name] = value;
        else element.setAttribute(name, String(value));
    }
    element.append(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
    return element;
}

export function count(amount, singular, plural) {
    return `${amount} ${amount === 1 ? singular : plural}`;
}

export function pill(text, tone = "") {
    return el("span", { className: `pill ${tone}` }, text);
}

let toastTimer;
export function toast(message) {
    toastBox.textContent = message;
    toastBox.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastBox.classList.remove("visible"), TOAST_MS);
}

async function request(path, options) {
    const response = await fetch(`/api${path}`, {
        method: options.method ?? "GET",
        headers: {
            authorization: `Bearer ${session.token}`,
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (response.status === 401) {
        hooks.onUnauthorized();
        throw new Error("Signed out");
    }
    return response;
}

/** For binary responses. An <img src> can't send the auth header, so pictures come through here. */
export async function apiBlob(path) {
    const response = await request(path, {});
    if (!response.ok) throw new Error("That didn't work");
    return response.blob();
}

export async function api(path, options = {}) {
    const response = await request(path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "That didn't work");
    return data;
}

/** Runs something the operator asked for, and reports any failure where they can see it. */
export async function act(work, done) {
    try {
        await work();
        if (done) toast(done);
    } catch (error) {
        toast(error.message);
    }
}

/** Rounds up, so a wait is never shown as zero. */
export function minutesLeft(ms) {
    return Math.ceil(ms / 60_000);
}

export function formatTime(at) {
    if (at === null || at === undefined) return "";
    const date = new Date(at);
    const sameDay = date.toDateString() === new Date().toDateString();
    return date.toLocaleString(
        undefined,
        sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
    );
}

export function openDialog(...children) {
    dialog.replaceChildren(
        ...children.flat().filter(Boolean),
        el("div", { className: "actions" }, el("button", { className: "push", onclick: () => dialog.close() }, "Close")),
    );
    if (!dialog.open) dialog.showModal();
}

export function renderEvents(events) {
    return events.map((event) =>
        el(
            "div",
            { className: "event" },
            el("b", {}, event.kind),
            ` · ${formatTime(event.at)}`,
            event.detail ? el("pre", {}, JSON.stringify(event.detail, null, 2)) : undefined,
        ),
    );
}
