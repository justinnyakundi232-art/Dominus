// For blocking the current site when the user clicks the "BLOCK SITE" button
let currentDomain = null;

// Cached category model, so the blocked list can name where each block came
// from without re-reading storage per row. Refreshed by renderBlockedList().
let categoryDefs = [];
let manualSites = [];

// REMOVE_COOLDOWN_SECONDS — seconds the confirm button stays locked before a
// block can be permanently removed — now lives in Tasks.js, shared with the
// task-removal gate on the fortress page.

document.addEventListener("DOMContentLoaded", async () => {
    renderBlockedList();
    renderSealNotice(document.getElementById("sealNotice"));

    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Guard against chrome:// or other non-blockable pages
    if (!tab.url || !tab.url.startsWith("http")) {
        document.getElementById("blockBtn").textContent = "CANNOT BLOCK THIS PAGE";
        document.getElementById("blockBtn").disabled = true;
        return;
    }

    currentDomain = new URL(tab.url).hostname.replace(/^www\./, "");

    // Derived rather than read from blockedSites, so the button is right even
    // on the very first load after upgrading, before migration has written the
    // derived list back.
    loadCategories().then(({ categories, manualSites: manual }) => {
        updateBlockButton(computeBlockedSites(categories, manual));
    });
});

// Updates the main block button's label/state for the active tab's domain
function updateBlockButton(blocked) {
    if (!currentDomain) return;
    const blockBtn = document.getElementById("blockBtn");

    if (blocked.includes(currentDomain)) {
        blockBtn.textContent = `${currentDomain.toUpperCase()} IS BLOCKED`;
        blockBtn.disabled = true;
    } else {
        blockBtn.textContent = `BLOCK ${currentDomain.toUpperCase()}`;
        blockBtn.disabled = false;
    }
}

document.getElementById("blockBtn").addEventListener("click", async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || !tab.url.startsWith("http")) return;

    let domain = new URL(tab.url).hostname.replace(/^www\./, "");

    // Recorded in manualSites as well as blockedSites. Without that second
    // list, ticking and then unticking a category on the fortress page would
    // delete a hand-blocked site that happened to appear in its preset list.
    loadCategories().then(({ categories, manualSites: manual }) => {
        if (computeBlockedSites(categories, manual).includes(domain)) return;

        // Blocking a site is strengthening, so this never meets the seal. It
        // still goes through commitFortress() rather than writing storage
        // directly, so blockedSites is derived in one place instead of three.
        commitFortress({
            categories: categories,
            manualSites: manual.concat([domain])
        }).then(() => {
            chrome.tabs.update(tab.id, {
                url: chrome.runtime.getURL("Blocked.html") +
                    "?url=" + encodeURIComponent(tab.url)
            });
        });
    });
});

document.getElementById("trackBtn").addEventListener("click", async () => {
    chrome.tabs.create({
        url: chrome.runtime.getURL("TrackProgress.html")
    });
});

// For creating a new tab with the "Build Fortress" page when the user clicks the "BUILD THE FORTRESS" button
document.getElementById("buildBtn").addEventListener("click", async () => {
    chrome.tabs.create({
        url: chrome.runtime.getURL("BuildFortress.html")
    });
});

// Renders the "Currently Blocked" list with per-site remove buttons, each
// annotated with the category (or categories) it comes from.
//
// The list is derived from the category model rather than read straight out of
// blockedSites, so what's shown and what's enforced can't disagree.
function renderBlockedList() {
    loadCategories().then(({ categories, manualSites: manual }) => {
        categoryDefs = categories;
        manualSites = manual;

        const groups = groupBlockedSites(categories, manual);
        const section = document.getElementById("blockedListSection");
        const list = document.getElementById("blockedList");

        list.innerHTML = "";

        if (groups.length === 0) {
            section.hidden = true;
            return;
        }

        section.hidden = false;

        groups.forEach((group) => {
            list.appendChild(buildGroupHeading(group.category));
            group.sites.forEach((domain) => {
                list.appendChild(buildBlockedRow(domain, categories));
            });
        });
    });
}

// The banner heading a group of blocked sites. A null category is the
// catch-all: sites blocked by hand, or left over from a category that has since
// been switched off.
function buildGroupHeading(category) {
    const heading = document.createElement("li");
    heading.className = "blocked-group";

    if (!category) {
        heading.textContent = "Added manually";
        return heading;
    }

    const badge = document.createElement("span");
    badge.className = "blocked-group-badge";
    badge.style.color = categoryColorValue(category);
    badge.textContent = category.glyph;

    const name = document.createElement("span");
    name.textContent = category.name;

    heading.appendChild(badge);
    heading.appendChild(name);

    // Worth flagging here rather than only on the blocked page: it is the
    // difference between a block you can talk your way past and one you can't.
    if (category.permanent) {
        const note = document.createElement("span");
        note.className = "blocked-group-note";
        note.textContent = "permanent";
        heading.appendChild(note);
    }

    return heading;
}

function buildBlockedRow(domain, categories) {
    const item = document.createElement("li");
    item.className = "blocked-item";

    const label = document.createElement("div");
    label.className = "blocked-item-label";

    const name = document.createElement("span");
    name.className = "blocked-item-domain";
    name.textContent = domain;
    label.appendChild(name);

    // The group heading already names the category governing this site, so the
    // subtext only carries what the heading can't: the other categories the
    // site also belongs to, which decide nothing here but explain why removing
    // it touches more than one place.
    const also = secondaryCategoriesForDomain(categories, domain);
    if (also.length) {
        const source = document.createElement("span");
        source.className = "blocked-item-source";
        source.textContent = `also in ${also.map((c) => c.name).join(", ")}`;
        label.appendChild(source);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-blocked-btn";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Unblock ${domain}`);
    removeBtn.addEventListener("click", () => openRemoveModal(domain));

    item.appendChild(label);
    item.appendChild(removeBtn);
    return item;
}

// --- Removal friction gate ------------------------------------------------
// Instead of the "x" instantly deleting a block (which quietly undoes the whole
// blocked-page gauntlet), route it through a confirmation that (a) shows the
// discipline streak at stake and (b) enforces a short cooldown before the
// confirm button works — beating the impulsive in-the-moment decision.

const removeModal = document.getElementById("removeModal");
const removeModalStreak = document.getElementById("removeModalStreak");
const removeModalText = document.getElementById("removeModalText");
const removeModalCancel = document.getElementById("removeModalCancel");
const removeModalConfirm = document.getElementById("removeModalConfirm");

let pendingRemoveDomain = null;
let removeCountdownInterval = null;

function openRemoveModal(domain) {
    // A sealed fortress meets the seal prompt the moment this removal commits,
    // and that prompt names the same site, shows the same streak, and asks for
    // the password on top of it. Raising this one first would be two dialogs
    // for one click, which is how a feature ends up switched off.
    isSealed().then((sealed) => {
        if (sealed) return removeBlockedSite(domain);
        openRemoveConfirmation(domain);
    });
}

function openRemoveConfirmation(domain) {
    pendingRemoveDomain = domain;

    const owning = categoriesForDomain(categoryDefs, domain);

    const lines = [
        `Permanently remove ${domain} from your blocked list? This undoes the block completely.`
    ];

    // Removing a site that a category is responsible for has to take it out of
    // that category too, or the next fortress save would silently put it back.
    // That's a bigger edit than the row suggests, so it gets said out loud
    // rather than discovered later.
    if (owning.length) {
        const names = owning.map((category) => category.name).join(" and ");
        lines.push(`It will also be removed from ${names}.`);

        if (owning.some((category) => category.permanent)) {
            lines.push("You marked that category permanently blocked.");
        }
    }

    removeModalText.textContent = lines.join(" ");

    // Show the streak at stake. getStats() is async; guard against the modal
    // being closed or retargeted before it resolves.
    removeModalStreak.textContent = "";
    getStats().then((stats) => {
        if (pendingRemoveDomain !== domain) return;
        if (stats.currentStreak > 0) {
            const days = stats.currentStreak;
            removeModalStreak.textContent =
                `You're on a ${days}-day discipline streak — don't dismantle what you've built.`;
        }
    });

    removeModal.hidden = false;
    startRemoveCooldown();
}

// Locks the confirm button, then counts down before enabling it.
function startRemoveCooldown() {
    clearInterval(removeCountdownInterval);
    let remaining = REMOVE_COOLDOWN_SECONDS;

    removeModalConfirm.disabled = true;
    removeModalConfirm.classList.add("disabled");
    removeModalConfirm.textContent = `CONFIRM (${remaining})`;

    removeCountdownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(removeCountdownInterval);
            removeModalConfirm.disabled = false;
            removeModalConfirm.classList.remove("disabled");
            removeModalConfirm.textContent = "REMOVE BLOCK";
        } else {
            removeModalConfirm.textContent = `CONFIRM (${remaining})`;
        }
    }, 1000);
}

function closeRemoveModal() {
    clearInterval(removeCountdownInterval);
    removeModal.hidden = true;
    pendingRemoveDomain = null;
}

removeModalCancel.addEventListener("click", closeRemoveModal);

removeModalConfirm.addEventListener("click", () => {
    if (removeModalConfirm.disabled || !pendingRemoveDomain) return;
    const domain = pendingRemoveDomain;
    closeRemoveModal();
    removeBlockedSite(domain);
});

// Removes a single domain everywhere it is blocked from, and refreshes the UI.
//
// It has to come out of the categories as well as the manual list: leaving it
// in an enabled category would mean the row reappears the next time the
// fortress is saved, which reads as the removal having silently failed.
function removeBlockedSite(domain) {
    loadCategories().then(({ categories, manualSites: manual }) => {
        const updatedCategories = categories.map((category) => {
            if (!category.sites.includes(domain)) return category;
            return Object.assign({}, category, {
                sites: category.sites.filter((site) => site !== domain)
            });
        });

        commitFortress({
            categories: updatedCategories,
            manualSites: manual.filter((site) => site !== domain)
        }).then((outcome) => {
            // A refused commit wrote nothing, so there is nothing to redraw —
            // the site is still blocked and the list already says so.
            if (!outcome.saved) return;

            renderBlockedList();
            updateBlockButton(outcome.blockedSites);
        });
    });
}