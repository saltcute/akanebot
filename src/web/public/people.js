import { showPerson } from "./dialogs.js";
import { act, api, count, el, formatTime, pill, toast } from "./ui.js";

const people = { list: [], selected: undefined, search: "" };

async function load() {
    const { people: list } = await api("/people");
    people.list = list;
    if (!list.some((person) => person.key === people.selected)) people.selected = undefined;
}

function matches(person) {
    const search = people.search.toLowerCase();
    return search === "" || [person.name, ...person.accounts, ...person.aliases].some((text) => text.toLowerCase().includes(search));
}

function personBadges(person) {
    return [
        person.optedOut ? pill("Opted out", "danger") : undefined,
        person.note === undefined ? undefined : pill("Known", "accent"),
        el("span", {}, count(person.messages, "message", "messages")),
        person.lastSeen === undefined ? undefined : el("span", {}, formatTime(person.lastSeen)),
    ];
}

function renderRows() {
    const shown = people.list.filter(matches);
    if (shown.length === 0) return el("div", { className: "empty" }, "Nobody matches.");
    return el(
        "ul",
        { className: "rows" },
        shown.map((person) =>
            el(
                "li",
                {},
                el(
                    "button",
                    {
                        className: "row",
                        "aria-current": String(person.key === people.selected),
                        onclick: () => {
                            people.selected = person.key;
                            render();
                        },
                    },
                    el("div", { className: "row-head" }, el("span", { className: "row-title" }, person.name)),
                    el("div", { className: "meta" }, personBadges(person)),
                ),
            ),
        ),
    );
}

function score(value) {
    return value === undefined ? "None yet" : value.toFixed(2);
}

function slider(label, value, min) {
    const output = el("output", {}, value.toFixed(2));
    const input = el("input", {
        type: "range",
        min: String(min),
        max: "1",
        step: "0.01",
        value: String(value),
        "aria-label": label,
        oninput: () => {
            input.dataset.touched = "true";
            output.textContent = Number(input.value).toFixed(2);
        },
    });
    return { input, field: el("label", { className: "field" }, label, el("div", { className: "range" }, input, output)) };
}

function renderStanding(person) {
    const path = `/people/${encodeURIComponent(person.key)}/relationship`;
    const familiarity = slider("Familiarity", person.standing.familiarity, 0);
    const affinity = slider("Affinity", person.standing.affinity, -1);
    const reload = async () => {
        await load();
        render();
    };
    // Only what was moved gets sent, so saving one value can't round off the other.
    const changed = () =>
        Object.fromEntries(
            [
                ["familiarity", familiarity.input],
                ["affinity", affinity.input],
            ]
                .filter(([, input]) => input.dataset.touched === "true")
                .map(([name, input]) => [name, Number(input.value)]),
        );
    const save = () =>
        act(async () => {
            const body = changed();
            if (Object.keys(body).length === 0) throw new Error("Move a slider first");
            await api(path, { method: "PATCH", body });
            await reload();
        }, "Saved");
    const reset = () => {
        if (!confirm(`Make ${person.name} a stranger to her again? Her memories of them stay.`)) return;
        act(async () => {
            await api(path, { method: "DELETE" });
            await reload();
        }, "Reset");
    };
    return [
        familiarity.field,
        affinity.field,
        el(
            "div",
            { className: "actions" },
            el("button", { className: "primary", onclick: save }, "Save"),
            el("button", { onclick: reset }, "Reset relationship"),
        ),
    ];
}

function optOut(person) {
    return act(async () => {
        const path = `/people/${encodeURIComponent(person.key)}`;
        const impact = await api(path);
        const warning = `Opt out ${person.name}? She stops reading them on every account, and ${count(impact.memories, "memory", "memories")} and ${count(impact.messages, "logged message", "logged messages")} are deleted for good.`;
        if (!confirm(warning)) return;
        const { forgotten } = await api(`${path}/opt-out`, { method: "POST" });
        await load();
        render();
        toast(`Opted out, and forgot ${count(forgotten, "memory", "memories")}`);
    });
}

function optIn(person) {
    if (!confirm(`Opt ${person.name} back in? If they opted out themselves, this overrides their choice. Nothing already forgotten comes back.`))
        return;
    act(async () => {
        await api(`/people/${encodeURIComponent(person.key)}/opt-in`, { method: "POST" });
        await load();
        render();
    }, "Opted back in");
}

function renderDetail() {
    const person = people.list.find((candidate) => candidate.key === people.selected);
    if (!person) return el("div", { className: "empty" }, "Pick someone to see what she knows about them.");
    const fact = (label, value) => [el("dt", {}, label), el("dd", {}, value)];
    return el(
        "div",
        { className: "detail" },
        el("h2", { className: "detail-title" }, person.name),
        el("div", { className: "meta" }, personBadges(person)),
        el(
            "dl",
            { className: "facts" },
            fact("Accounts", person.accounts.join(", ")),
            person.aliases.length === 0 ? undefined : fact("Also called", person.aliases.join(", ")),
            person.note === undefined ? undefined : fact("How she knows them", person.note),
            fact("Familiarity", score(person.standing?.familiarity)),
            fact("Affinity", score(person.standing?.affinity)),
        ),
        person.standing ? renderStanding(person) : undefined,
        el("h3", {}, `Groups (${person.groups.length})`),
        person.groups.length === 0
            ? el("div", { className: "meta" }, "She hasn't formed an opinion in any group.")
            : person.groups.map((group) =>
                  el(
                      "div",
                      { className: "source" },
                      el("b", {}, group.name),
                      el("span", { className: "row-time" }, ` ${formatTime(group.updatedAt)}`),
                      el("p", {}, `Familiarity ${group.familiarity.toFixed(2)}, affinity ${group.affinity.toFixed(2)}`),
                  ),
              ),
        el(
            "div",
            { className: "actions" },
            person.optedOut
                ? el("button", { onclick: () => optIn(person) }, "Opt back in")
                : el("button", { className: "danger", onclick: () => optOut(person) }, "Opt out…"),
            el("button", { className: "danger push", onclick: () => showPerson(person.key) }, "Forget…"),
        ),
    );
}

function render() {
    const view = document.getElementById("view");
    if (!view) return;
    const listScroll = document.getElementById("people-scroll")?.scrollTop ?? 0;
    view.className = "split";
    view.replaceChildren(
        el(
            "section",
            { className: "pane", "aria-label": "People" },
            el(
                "div",
                { className: "toolbar" },
                el("input", {
                    type: "search",
                    placeholder: "Search people",
                    "aria-label": "Search people",
                    value: people.search,
                    oninput: (event) => {
                        people.search = event.target.value.trim();
                        document.getElementById("people-scroll").replaceChildren(renderRows());
                    },
                }),
            ),
            el("div", { className: "scroll", id: "people-scroll" }, renderRows()),
        ),
        el("section", { className: "pane", "aria-label": "Person" }, el("div", { className: "scroll" }, renderDetail())),
    );
    document.getElementById("people-scroll").scrollTop = listScroll;
}

export const peopleTab = { label: "People", load, render };
