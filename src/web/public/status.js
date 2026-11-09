import { act, api, BODY_STATES, count, el, formatTime, pill } from "./ui.js";

const ACTIVITIES = { asleep: "Asleep", busy: "Busy with her day", free: "Free" };

let body;

async function load() {
    body = await api("/body");
}

function fact(label, value) {
    return [el("dt", {}, label), el("dd", {}, value)];
}

function card(title, ...children) {
    return el("section", { className: "card" }, el("h3", {}, title), ...children);
}

function percent(value) {
    return `${Math.round(value * 100)}%`;
}

function moodWord(mood) {
    if (mood > 0.5) return "Good";
    if (mood < -0.5) return "Bad";
    return "Ordinary";
}

function renderNow() {
    return card(
        "Right now",
        el(
            "dl",
            { className: "facts" },
            fact("Body", BODY_STATES[body.state] ?? body.state),
            fact("Attending", body.attending?.name ?? "Nothing"),
            fact("Away because", body.awayReasons.length > 0 ? body.awayReasons.join(", ") : "Not away"),
            fact("Schedule", ACTIVITIES[body.activity] ?? body.activity),
            body.present === undefined ? undefined : fact("Looking at chat", body.present ? "Yes" : "No"),
        ),
    );
}

function renderDay() {
    return card(
        "Today",
        el(
            "dl",
            { className: "facts" },
            fact("Mood", `${moodWord(body.day.mood)} (${body.day.mood.toFixed(2)})`),
            fact("Likelihood to join", `× ${body.day.joinFactor.toFixed(2)}`),
            fact("Searches", `${body.searchesToday} of ${body.searchCap}`),
        ),
        body.day.notes.length > 0
            ? el(
                  "ul",
                  { className: "notes" },
                  body.day.notes.map((note) => el("li", {}, note)),
              )
            : undefined,
    );
}

function renderEnergy() {
    const output = el("output", {}, percent(body.battery));
    const input = el("input", {
        type: "range",
        min: "0",
        max: "1",
        step: "0.01",
        value: String(body.battery),
        "aria-label": "Social battery",
        oninput: () => {
            output.textContent = percent(Number(input.value));
        },
    });
    const save = () =>
        act(async () => {
            await api("/body/battery", { method: "PUT", body: { level: Number(input.value) } });
            await load();
            render();
        }, "Saved");
    return card(
        "Social battery",
        el("div", { className: "range" }, input, output),
        el("div", { className: "actions" }, el("button", { onclick: save }, "Set battery")),
        el("p", { className: "meta" }, "Refills by itself when her day rolls over."),
    );
}

function renderGuard() {
    return card(
        "Send limits",
        el(
            "dl",
            { className: "facts" },
            fact("Rate tokens", `${body.guard.tokens} of ${body.guard.capacity}`),
            fact("Most she may talk", percent(body.guard.maxShare)),
        ),
        body.guard.channels.map((channel) =>
            el(
                "div",
                { className: "source" },
                el("b", {}, channel.name),
                " ",
                channel.share > body.guard.maxShare ? pill("Over the limit", "warn") : undefined,
                el("p", {}, `${percent(channel.share)} of the last ${count(channel.sample, "message", "messages")}`),
            ),
        ),
    );
}

function renderSpend() {
    const { spentTodayUsd, spentTotalUsd, dailyBudgetUsd, unpricedModels } = body.cost;
    return card(
        "Spend",
        el(
            "dl",
            { className: "facts" },
            fact("Today", `$${spentTodayUsd.toFixed(2)} of $${dailyBudgetUsd.toFixed(2)}`),
            fact("Since the bot last started", `$${spentTotalUsd.toFixed(2)}`),
            unpricedModels.length > 0 ? fact("No price set for", unpricedModels.join(", ")) : undefined,
        ),
    );
}

function renderMemory() {
    const { memory, lastNight } = body;
    return card(
        "Memory",
        el(
            "dl",
            { className: "facts" },
            fact("Active", String(memory.active)),
            fact("Archived", String(memory.archived)),
            fact("Replaced", String(memory.replaced)),
            memory.unindexed > 0 ? fact("Not indexed", String(memory.unindexed)) : undefined,
            fact("Logged messages", String(memory.messages)),
            fact("Last nightly run", lastNight.date ?? "Not yet"),
            lastNight.finishedAt === undefined ? undefined : fact("Finished", formatTime(lastNight.finishedAt)),
            lastNight.report
                ? fact(
                      "Result",
                      Object.entries(lastNight.report)
                          .map(([name, total]) => `${name} ${total}`)
                          .join(", "),
                  )
                : undefined,
        ),
    );
}

function render() {
    const view = document.getElementById("view");
    if (!view || !body) return;
    const scroll = view.scrollTop;
    view.className = "single";
    view.replaceChildren(el("div", { className: "cards" }, renderNow(), renderDay(), renderEnergy(), renderGuard(), renderSpend(), renderMemory()));
    view.scrollTop = scroll;
}

/** A redraw would throw away a value the operator is still choosing. */
function editing() {
    return document.getElementById("view")?.contains(document.activeElement) && document.activeElement.matches("input, select, textarea");
}

export const statusTab = { label: "Status", load, render, editing, live: () => JSON.stringify(body) };
