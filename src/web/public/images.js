// Everything shown here can come from strangers in a chat, so text only ever enters the page as text nodes.

import { showPerson } from "./dialogs.js";
import { act, api, apiBlob, dialog, el, formatTime, openDialog, pill, SEARCH_DELAY_MS } from "./ui.js";

const IMAGES_PER_PAGE = 24;

const gallery = { images: [], total: 0, scopes: [], people: [], filters: { q: "", scope: "", user: "" }, offset: 0 };

/** Object URLs by image ID. Pictures need the auth header, so a plain src can't fetch them, and they stay held in memory until revoked. */
const previews = new Map();

function dropOtherPreviews() {
    const shown = new Set(gallery.images.map((image) => image.id));
    for (const [id, url] of previews) {
        if (shown.has(id)) continue;
        URL.revokeObjectURL(url);
        previews.delete(id);
    }
}

async function showPreview(img) {
    const id = Number(img.dataset.imageId);
    if (!previews.has(id)) previews.set(id, URL.createObjectURL(await apiBlob(`/images/${id}/content`)));
    img.src = previews.get(id);
}

/** A page of GIFs can be over a hundred megabytes, so each is only fetched once it scrolls into view. */
const whenVisible = new IntersectionObserver((entries) => {
    for (const { isIntersecting, target } of entries) {
        if (!isIntersecting) continue;
        whenVisible.unobserve(target);
        showPreview(target).catch(() => {
            target.alt = "Couldn't load this picture";
        });
    }
});

async function fetchPage() {
    const query = new URLSearchParams({ limit: String(IMAGES_PER_PAGE), offset: String(gallery.offset) });
    for (const [name, value] of Object.entries(gallery.filters)) if (value) query.set(name, value);
    Object.assign(gallery, await api(`/images?${query}`));
    dropOtherPreviews();
}

async function load() {
    const [{ people }] = await Promise.all([api("/people"), fetchPage()]);
    gallery.people = people;
}

function refresh() {
    return act(async () => {
        await fetchPage();
        render();
    });
}

function edit(image) {
    const description = el("textarea", { rows: 3, value: image.description, required: true, maxLength: 200 });
    const useFor = el("input", { type: "text", value: image.useFor, required: true, maxLength: 40 });
    const save = (event) => {
        event.preventDefault();
        act(async () => {
            await api(`/images/${image.id}`, { method: "PATCH", body: { description: description.value, useFor: useFor.value } });
            dialog.close();
            await fetchPage();
            render();
        }, "Saved");
    };
    openDialog(
        el("h2", {}, "Edit picture"),
        el(
            "form",
            { onsubmit: save },
            el("label", { className: "field" }, "What she sees it as", description),
            el("label", { className: "field" }, "Good for", useFor),
            el("div", { className: "actions" }, el("button", { className: "primary", type: "submit" }, "Save")),
        ),
    );
}

function remove(image) {
    if (!confirm("Delete this picture? She can't send it again, but she can save it again if someone posts it.")) return;
    act(async () => {
        await api(`/images/${image.id}`, { method: "DELETE" });
        await fetchPage();
        render();
    }, "Deleted");
}

function renderPicture(image) {
    if (image.link !== null) {
        // Only ever a link to a GIF site, and the page may not load anything from those, so it opens in its own tab.
        return el("div", { className: "image-frame" }, el("a", { href: image.link, target: "_blank", rel: "noreferrer noopener" }, "Open GIF link"));
    }
    const picture = el("img", { alt: image.description, "data-image-id": image.id });
    whenVisible.observe(picture);
    return el("div", { className: "image-frame" }, picture);
}

function renderCard(image) {
    return el(
        "article",
        { className: "card image-card" },
        renderPicture(image),
        el("p", {}, image.description),
        el("p", { className: "meta" }, `Good for: ${image.useFor}`),
        el(
            "p",
            { className: "meta" },
            "From ",
            el("button", { className: "link", onclick: () => showPerson(image.userKey) }, image.posterName),
            ` in ${image.scopeName}, ${formatTime(image.savedAt)}`,
        ),
        el(
            "div",
            { className: "actions" },
            image.link === null ? undefined : pill("Link"),
            image.timesSent > 0 ? pill(`Sent ${image.timesSent}×`, "ok") : pill("Never sent"),
            el("span", { className: "row-time" }, `Liked ${image.appeal.toFixed(2)}`),
            el("button", { className: "push", onclick: () => edit(image) }, "Edit"),
            el("button", { onclick: () => remove(image) }, "Delete"),
        ),
    );
}

function renderGallery() {
    if (gallery.images.length === 0) return el("div", { className: "empty" }, "No saved pictures match.");
    return el("div", { className: "cards image-cards" }, gallery.images.map(renderCard));
}

function renderPager() {
    const { total, offset } = gallery;
    const first = total === 0 ? 0 : offset + 1;
    const last = Math.min(offset + IMAGES_PER_PAGE, total);
    const go = (target) => {
        gallery.offset = target;
        refresh();
    };
    return el(
        "div",
        { className: "pager", id: "images-pager" },
        el("span", {}, `${first}–${last} of ${total}`),
        el(
            "div",
            { className: "actions" },
            el("button", { disabled: offset === 0, onclick: () => go(Math.max(0, offset - IMAGES_PER_PAGE)) }, "Newer"),
            el("button", { disabled: last >= total, onclick: () => go(offset + IMAGES_PER_PAGE) }, "Older"),
        ),
    );
}

function applyFilter(name, value) {
    return act(async () => {
        gallery.filters[name] = value;
        gallery.offset = 0;
        await fetchPage();
        document.getElementById("images-scroll").replaceChildren(renderGallery());
        document.getElementById("images-pager").replaceWith(renderPager());
    });
}

let searchTimer;
function renderToolbar() {
    const select = (name, label, options) =>
        el(
            "select",
            { "aria-label": label, onchange: (event) => applyFilter(name, event.target.value) },
            options.map(([value, text]) => el("option", { value, selected: gallery.filters[name] === value }, text)),
        );
    return el(
        "div",
        { className: "toolbar" },
        el("input", {
            type: "search",
            placeholder: "Search pictures",
            "aria-label": "Search pictures",
            value: gallery.filters.q,
            oninput: (event) => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => applyFilter("q", event.target.value.trim()), SEARCH_DELAY_MS);
            },
        }),
        select("scope", "Saved in", [["", "All conversations"], ...gallery.scopes.map((scope) => [scope.key, scope.name])]),
        select("user", "Posted by", [["", "Everyone"], ...gallery.people.map((person) => [person.key, person.name])]),
    );
}

function render() {
    const view = document.getElementById("view");
    if (!view) return;
    view.className = "split one-pane";
    view.replaceChildren(
        el(
            "section",
            { className: "pane", "aria-label": "Saved pictures" },
            renderToolbar(),
            el("div", { className: "scroll", id: "images-scroll" }, renderGallery()),
            renderPager(),
        ),
    );
}

export const imagesTab = { label: "Images", load, render };
