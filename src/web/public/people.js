import { showPerson } from "./dialogs.js";
import { act, api, count, el, formatTime, pill } from "./ui.js";

const people = { list: [], selected: undefined, search: "" };

async function load() {
    const { people: list } = await api("/people");
    people.list = list;
    if (!list.some((person) => person.key === people.selected)) people.selected = undefined;
}

function matches(person) {
    const search = people.search.toLowerCase();
    return search === "" || person.name.toLowerCase().includes(search) || person.accounts.some((account) => account.toLowerCase().includes(search));
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
            person.note === undefined ? undefined : fact("How she knows them", person.note),
            fact("Familiarity", score(person.standing?.familiarity)),
            fact("Affinity", score(person.standing?.affinity)),
        ),
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
        el("div", { className: "actions" }, el("button", { className: "danger push", onclick: () => act(() => showPerson(person.key)) }, "Forget…")),
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
