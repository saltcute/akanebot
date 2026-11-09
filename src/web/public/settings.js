import { api, el, pill } from "./ui.js";

const settings = { persona: undefined, config: undefined, configMissing: false };

async function load() {
    const [persona, config] = await Promise.all([api("/persona"), api("/config").catch(() => undefined)]);
    settings.persona = persona;
    settings.config = config;
    settings.configMissing = config === undefined;
}

function section(title, value) {
    return el("div", { className: "event" }, el("b", {}, title), el("pre", {}, JSON.stringify(value, null, 2)));
}

function renderPersona() {
    const { prose, ...rest } = settings.persona;
    return el(
        "div",
        { className: "detail" },
        el("h2", { className: "detail-title" }, rest.name),
        el("p", { className: "meta" }, "Read-only. Edit the persona file and it reloads by itself."),
        el("h3", {}, "How she is written"),
        el("p", { className: "message-text" }, prose),
        el("h3", {}, "Settings"),
        Object.entries(rest).map(([name, value]) => section(name, value)),
    );
}

function renderDisk({ disk }) {
    if (disk.state === "matches") return pill("Matches the file", "ok");
    if (disk.state === "unreadable") return pill("File can't be read", "danger");
    return pill(`Restart needed: ${disk.sections.join(", ")}`, "warn");
}

function renderConfig() {
    if (settings.configMissing) return el("div", { className: "empty" }, "This run has no config to show.");
    const { path, overrides, config } = settings.config;
    return el(
        "div",
        { className: "detail" },
        el("h2", { className: "detail-title" }, "Config"),
        el("div", { className: "meta" }, renderDisk(settings.config), el("span", {}, path)),
        el("p", { className: "meta" }, "Read-only, and credentials are never shown. Changes need a restart."),
        overrides.length > 0 ? el("p", { className: "meta" }, `This run replaces: ${overrides.join(", ")}.`) : undefined,
        Object.entries(config)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => section(name, value)),
    );
}

function render() {
    const view = document.getElementById("view");
    if (!view) return;
    view.className = "split wide-list";
    view.replaceChildren(
        el("section", { className: "pane", "aria-label": "Persona" }, el("div", { className: "scroll" }, renderPersona())),
        el("section", { className: "pane", "aria-label": "Config" }, el("div", { className: "scroll" }, renderConfig())),
    );
}

export const settingsTab = { label: "Settings", load, render };
