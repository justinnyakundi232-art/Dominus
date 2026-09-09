// app.js — the desktop window's shell.
//
// Deliberately the same shape as the extension's App.js: hash routing, views
// hidden rather than rebuilt, a refresh hook per view. The two surfaces should
// behave the same way, not merely look alike.
//
// Until the two are paired, every view is an empty state, and the honest job of
// this file is to make that first run legible rather than to hide it.
//
// The Fortress is the first view here that WRITES. It authors an edit the same
// way Seal.js does in the extension — work out what the edit gave up, stamp a
// record for it, raise the revision — by running the very Sync.js the extension
// runs, copied in by tools/sync-shared.mjs and loaded as a classic script
// before this module. There is no second implementation of the merge rules
// anywhere, which is the whole design; see SYNC-PROTOCOL.md.
//
// The window reaches the Rust side through `window.__TAURI__`, which exists
// because `withGlobalTauri` is on — the frontend is deliberately plain HTML
// with no bundler, so it cannot import @tauri-apps/api. It still runs in an
// ordinary browser with no bridge at all, which is how the UI is developed.

const ROUTES = ["keep", "fortress", "campaign", "seal", "order"];
const DEFAULT_ROUTE = "keep";

const scrollPositions = {};
let currentRoute = null;

function scroller() {
    return document.querySelector(".view-region");
}

// ---- The seam to the native side -----------------------------------------
//
// The Rust half runs the loopback service described in SYNC-PROTOCOL.md.

function hasBridge() {
    return Boolean(window.__TAURI__ && window.__TAURI__.core);
}

const service = {
    async status() {
        // Three different states, and they were worth telling apart. "No
        // bridge" means this page is running in a plain browser — which is how
        // the UI is developed, and is also what a broken withGlobalTauri looks
        // like. "Not running" means the app is real but every port in the range
        // was taken. Reporting the first as the second sent me looking for a
        // dead service that was answering perfectly well.
        if (!hasBridge()) {
            return { bridge: false, running: false, port: null, paired: false, devices: [] };
        }

        try {
            const status = await window.__TAURI__.core.invoke("service_status");
            return Object.assign({ bridge: true }, status);
        } catch (error) {
            return { bridge: true, running: false, port: null, paired: false, devices: [], error: String(error) };
        }
    },

    async newPairingCode() {
        if (!hasBridge()) return null;
        try {
            return await window.__TAURI__.core.invoke("new_pairing_code");
        } catch (error) {
            return null;
        }
    },

    // This app's copy of the fortress, with the revision it is at and this
    // app's own device id. `state` is null before anything has been synced.
    async peerState() {
        if (!hasBridge()) return { stateRev: 0, state: null, device: "" };
        try {
            return await window.__TAURI__.core.invoke("peer_state");
        } catch (error) {
            return { stateRev: 0, state: null, device: "" };
        }
    },

    // Writes an edit made here. Resolves the new revision, or null if a sync
    // landed underneath it — in which case nothing was written and the window
    // re-reads rather than arguing.
    async putState(expectedRev, next) {
        if (!hasBridge()) return null;
        try {
            return await window.__TAURI__.core.invoke("put_state", {
                expectedRev: expectedRev,
                next: next
            });
        } catch (error) {
            return null;
        }
    }
};

// ---- Routing --------------------------------------------------------------

function routeFromHash() {
    const raw = (location.hash || "").replace(/^#\/?/, "");
    return ROUTES.includes(raw) ? raw : DEFAULT_ROUTE;
}

function refreshHookFor(route) {
    if (route === "seal") return refreshSeal;
    if (route === "keep") return refreshKeep;
    if (route === "fortress") return refreshFortress;
    return null;
}

function show(route) {
    if (route === currentRoute) {
        const hook = refreshHookFor(route);
        if (hook) hook();
        return;
    }

    const pane = scroller();
    if (currentRoute && pane) scrollPositions[currentRoute] = pane.scrollTop;

    ROUTES.forEach((name) => {
        const view = document.getElementById(`view-${name}`);
        if (view) view.classList.toggle("is-active", name === route);
    });

    document.querySelectorAll(".rail-link").forEach((link) => {
        if (link.dataset.route === route) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });

    currentRoute = route;

    const hook = refreshHookFor(route);
    if (hook) hook();

    if (pane) pane.scrollTop = scrollPositions[route] || 0;
}

function navigate(route) {
    if (!ROUTES.includes(route)) route = DEFAULT_ROUTE;
    if (routeFromHash() === route) return show(route);
    location.hash = `#/${route}`;
}

// ---- The Keep -------------------------------------------------------------
//
// Everything here is the extension's, mirrored. The figures and the wording
// match the extension's own Keep on purpose: one fortress read in two windows
// should not look like two different fortresses.

const plural = (n, one, many) => (n === 1 ? one : many);

function text(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

async function refreshKeep() {
    const empty = document.getElementById("keepEmpty");
    const content = document.getElementById("keepContent");
    if (!empty || !content) return;

    const { state } = await service.peerState();

    // Paired but never synced looks the same as unpaired here, and should: in
    // both cases this window has nothing of yours to show.
    if (!state || !state.stats) {
        empty.hidden = false;
        content.hidden = true;
        return;
    }

    empty.hidden = true;
    content.hidden = false;

    renderStanding(state);
    renderToday(state);
    renderDefences(state);
    renderGates(state);

    text("keepMirrored", "Mirrored from the extension" + (state.today ? " \u00b7 " + state.today : "") + ".");
}

function renderStanding(state) {
    const s = state.stats || {};

    text("keepStreak", s.currentStreak || 0);
    text("keepStreakNote", s.longestStreak
        ? "Longest " + s.longestStreak + " " + plural(s.longestStreak, "day", "days") : "");

    text("keepResistance", s.currentResistance || 0);
    text("keepResistanceNote", s.longestResistance
        ? "Longest " + s.longestResistance + " " + plural(s.longestResistance, "stand", "stands") : "");

    // The per-device counters are the canonical all-time totals: grow-only per
    // device, summed across them, which is what survives both merging and the
    // event log being pruned. The stats copy is this browser's own view, and
    // the fallback for a peer that predates them.
    let stands = 0;
    let unlocks = 0;
    const counters = state.counters || {};
    Object.keys(counters).forEach((id) => {
        stands += Number(counters[id].stands) || 0;
        unlocks += Number(counters[id].unlocks) || 0;
    });
    if (stands + unlocks === 0) {
        stands = Number(s.stayFocusedCount) || 0;
        unlocks = Number(s.unlockCount) || 0;
    }

    const total = stands + unlocks;
    text("keepVictory", total ? Math.round((stands / total) * 100) + "%" : "\u2014");
    text("keepVictoryNote", total
        ? "From " + total + " " + plural(total, "moment", "moments")
        : "Nothing has tested you yet");

    const rail = document.getElementById("railStreak");
    const railLabel = document.getElementById("railStreakLabel");
    if (rail && railLabel) {
        rail.textContent = s.currentStreak || 0;
        railLabel.textContent = s.currentStreak === 1 ? "day held" : "days held";
    }
}

function renderToday(state) {
    const band = document.getElementById("keepToday");
    const entry = (state.dayLog || {})[state.today];
    if (!band) return;

    band.classList.remove("is-held", "is-slipped");

    // The same three states the history grid uses. A day nothing asked
    // anything of you is not a day you won, and saying so is the point.
    if (entry && entry.unlocks > 0) {
        band.classList.add("is-slipped");
        const sites = Object.keys(entry.sites || {});
        text("keepTodayState", "A gate gave way today.");
        text("keepTodayDetail", sites.length
            ? sites[0] + (entry.firstSlip ? " at " + entry.firstSlip : "") + "."
            : "");
        return;
    }

    if (entry && entry.stands > 0) {
        band.classList.add("is-held");
        text("keepTodayState",
            "You have held the line " + entry.stands + " " + plural(entry.stands, "time", "times") + " today.");
        text("keepTodayDetail", "Every one of those was a choice.");
        return;
    }

    text("keepTodayState", "Nothing has tested you today.");
    text("keepTodayDetail", "An untested day keeps your streak \u2014 it just wasn't a fight.");
}

function renderDefences(state) {
    const fortress = state.fortress || {};
    const categories = fortress.categories || [];
    const manual = fortress.manualSites || [];

    // Derived here rather than read from the payload: blockedSites is a cache
    // and never travels, precisely so what is shown cannot disagree with what
    // the extension enforces.
    const blocked = new Set(manual);
    categories.forEach((c) => {
        if (c.enabled) (c.sites || []).forEach((site) => blocked.add(site));
    });

    const enabled = categories.filter((c) => c.enabled).length;

    if (blocked.size === 0) {
        text("keepDefences", "Nothing is blocked yet. The fortress has no walls.");
        return;
    }

    let line = blocked.size + " " + plural(blocked.size, "site", "sites") + " blocked";
    if (enabled) line += " across " + enabled + " " + plural(enabled, "category", "categories");
    if (manual.length) line += ", " + manual.length + " of them by hand";
    text("keepDefences", line + ".");
}

function renderGates(state) {
    const band = document.getElementById("keepGates");
    const list = document.getElementById("keepGateList");
    if (!band || !list) return;

    const unlocks = state.tempUnlocks || {};
    const now = Date.now();
    const open = Object.keys(unlocks)
        .map((domain) => ({ domain: domain, expiry: Number(unlocks[domain]) || 0 }))
        .filter((gate) => gate.expiry > now)
        .sort((a, b) => a.expiry - b.expiry);

    band.hidden = open.length === 0;
    list.textContent = "";

    open.forEach((gate) => {
        const item = document.createElement("li");
        item.className = "gate";

        const name = document.createElement("span");
        name.className = "gate-name";
        // A domain arrives over the wire and is never parsed as markup.
        name.textContent = gate.domain;

        const left = document.createElement("span");
        left.className = "gate-left";
        const mins = Math.ceil((gate.expiry - now) / 60000);
        left.textContent = mins + " " + plural(mins, "minute", "minutes") + " left";

        item.append(name, left);
        list.appendChild(item);
    });
}

// ---- The Fortress ---------------------------------------------------------
//
// The first view here that writes. It edits this app's copy; the extension
// picks it up on its next tick and merges it into what it enforces.
//
// Authoring an edit is the same two steps commitFortress() takes in the
// extension, run against the same code: work out what the edit gave up with
// describeAuthoredWeakening(), raise the revision, and append the record if
// anything came down. Without that record the merge — which is strengthen-wins
// — would simply put the defence back on the next tick, and nobody would be
// told why.

// The state this view is editing, and the revision it was read at. The revision
// is what put_state checks: if a sync landed underneath the edit, nothing is
// written and the view re-reads rather than arguing.
let fortressState = null;
let fortressRev = 0;
let fortressDevice = "";

// A weakening on a sealed fortress is refused here rather than prompted for.
// The seal's password prompt lives in the extension, and an app that let you
// around it would make the seal cheaper to get past by installing a second
// thing — which is the one test every rule in this design has to pass.
function fortressIsSealed() {
    return Boolean(fortressState && fortressState.seal && fortressState.seal.enabled);
}

function fortressSays(message, refused) {
    const el = document.getElementById("fortressStatus");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-refused", Boolean(refused));
}

async function refreshFortress() {
    const empty = document.getElementById("fortressEmpty");
    const content = document.getElementById("fortressContent");
    if (!empty || !content) return;

    const peer = await service.peerState();

    fortressState = peer.state;
    fortressRev = peer.stateRev;
    fortressDevice = peer.device;

    if (!fortressState || !fortressState.fortress) {
        empty.hidden = false;
        content.hidden = true;
        return;
    }

    empty.hidden = true;
    content.hidden = false;

    const sealed = document.getElementById("fortressSealed");
    if (sealed) sealed.hidden = !fortressIsSealed();

    renderCategories(fortressState.fortress.categories || []);
    renderManualSites(fortressState.fortress.manualSites || []);
}

function renderCategories(categories) {
    const list = document.getElementById("categoryList");
    const empty = document.getElementById("categoriesEmpty");
    if (!list || !empty) return;

    list.textContent = "";
    empty.hidden = categories.length > 0;

    const sealed = fortressIsSealed();

    categories.forEach((category) => {
        const item = document.createElement("li");
        item.className = "category" + (category.enabled ? "" : " is-down");

        const head = document.createElement("div");
        head.className = "category-head";

        const glyph = document.createElement("span");
        glyph.className = "category-glyph";
        glyph.setAttribute("aria-hidden", "true");
        glyph.textContent = category.glyph || "\u25a0";

        const name = document.createElement("span");
        name.className = "category-name";
        // A category is named by the user and arrives over the wire. It has no
        // business being parsed as markup.
        name.textContent = category.name || category.id;

        const count = document.createElement("span");
        count.className = "category-count";
        const sites = category.sites || [];
        count.textContent = category.enabled
            ? sites.length + " " + plural(sites.length, "site", "sites")
            : "stood down";

        head.append(glyph, name, count);
        item.appendChild(head);

        item.appendChild(renderSites(category, sealed));
        item.appendChild(renderAddSite(category));
        item.appendChild(renderCategoryActions(category, sealed));

        list.appendChild(item);
    });
}

function renderSites(category, sealed) {
    const sites = document.createElement("ul");
    sites.className = "site-list";

    (category.sites || []).forEach((site) => {
        const chip = document.createElement("li");
        chip.className = "chip";

        const label = document.createElement("span");
        label.textContent = site;

        const drop = document.createElement("button");
        drop.type = "button";
        drop.className = "chip-drop";
        drop.textContent = "\u00d7";
        drop.title = sealed
            ? "Sealed \u2014 remove this from the extension"
            : "Stop blocking " + site;
        drop.setAttribute("aria-label", "Stop blocking " + site);
        drop.disabled = sealed;
        drop.addEventListener("click", () => removeSite(category.id, site));

        chip.append(label, drop);
        sites.appendChild(chip);
    });

    return sites;
}

function renderAddSite(category) {
    const row = document.createElement("div");
    row.className = "site-add";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "example.com";
    input.setAttribute("aria-label", "Add a site to " + (category.name || category.id));

    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn-quiet";
    add.textContent = "BLOCK";

    // Adding a site is strengthening, so it is free on a sealed fortress too —
    // the seal is a toll on giving ground, never on taking it.
    const submit = () => {
        const typed = input.value;
        input.value = "";
        addSite(category.id, typed);
    };

    add.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
    });

    row.append(input, add);
    return row;
}

function renderCategoryActions(category, sealed) {
    const actions = document.createElement("div");
    actions.className = "category-actions";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn-quiet";
    toggle.textContent = category.enabled ? "STAND DOWN" : "TAKE UP";
    // Switching a category back on is strengthening. Switching it off is not.
    toggle.disabled = sealed && category.enabled;
    toggle.addEventListener("click", () => toggleCategory(category.id));
    actions.appendChild(toggle);

    // A permanent category cannot be removed at all — that is what permanent
    // means, and it means the same thing in both windows.
    if (!category.permanent) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn-quiet is-breach";
        remove.textContent = "REMOVE";
        remove.disabled = sealed;
        remove.addEventListener("click", () => removeCategory(category.id));
        actions.appendChild(remove);
    }

    return actions;
}

function renderManualSites(manual) {
    const list = document.getElementById("manualList");
    const note = document.getElementById("manualNote");
    if (!list || !note) return;

    list.textContent = "";

    if (!manual.length) {
        note.textContent = "Nothing blocked by hand.";
        return;
    }

    // Shown but not editable here, matching The Fortress in the extension. The
    // popup's Currently Blocked list is still the only place a hand-blocked site
    // comes off, on either surface.
    note.textContent = "Blocked one at a time from the extension's popup, which"
        + " is still the only place they come off.";

    manual.forEach((site) => {
        const chip = document.createElement("li");
        chip.className = "chip";
        chip.textContent = site;
        list.appendChild(chip);
    });
}

// ---- Editing --------------------------------------------------------------

function categoriesWith(id, change) {
    return (fortressState.fortress.categories || []).map((category) => (
        category.id === id ? change(category) : category
    ));
}

function toggleCategory(id) {
    commitEdit(categoriesWith(id, (category) => Object.assign({}, category, {
        enabled: !category.enabled,
        // Permanence cannot outlive being switched off — the same rule
        // normalizeCategoryList() enforces and applyAuthored() re-applies.
        permanent: category.enabled ? false : category.permanent
    })));
}

function addSite(id, typed) {
    const site = normalizeDomain(typed);
    if (!site) return fortressSays("That is not a site.", true);

    const category = (fortressState.fortress.categories || []).find((c) => c.id === id);
    if (category && (category.sites || []).includes(site)) {
        return fortressSays(site + " is already blocked there.");
    }

    commitEdit(categoriesWith(id, (c) => Object.assign({}, c, {
        sites: (c.sites || []).concat([site])
    })));
}

function removeSite(id, site) {
    commitEdit(categoriesWith(id, (category) => Object.assign({}, category, {
        sites: (category.sites || []).filter((held) => held !== site)
    })));
}

function removeCategory(id) {
    commitEdit((fortressState.fortress.categories || []).filter((c) => c.id !== id));
}

// Stamps and writes an edit. `categories` is the whole list, after.
//
// Nothing else in this file writes: every edit above builds a list and arrives
// here, for the same reason every edit in the extension goes through
// commitFortress() — a rule that lives in one place is a rule that exists.
async function commitEdit(categories) {
    const before = fortressState.fortress;
    const after = Object.assign({}, before, { categories: categories });

    const authored = describeAuthoredWeakening(before, after);

    if (authored && fortressIsSealed()) {
        // Should be unreachable — every control that could weaken is disabled
        // on a sealed fortress. Checked anyway, because "the button was greyed
        // out" is not an enforcement boundary.
        return fortressSays(
            "This fortress is sealed. That asks for your password, and the"
            + " prompt for it lives in the extension.",
            true
        );
    }

    const rev = (fortressState.fortressRev || 0) + 1;

    const next = Object.assign({}, fortressState, {
        fortress: after,
        fortressRev: rev,
        authored: authored
            ? normalizeAuthoredList((fortressState.authored || []).concat([
                Object.assign({ rev: rev, at: Date.now(), device: fortressDevice }, authored)
            ]))
            : (fortressState.authored || [])
    });

    const written = await service.putState(fortressRev, next);

    if (written === null) {
        // A sync landed underneath the edit, so it was refused and nothing was
        // written. Re-read and say so, rather than pushing over what arrived.
        await refreshFortress();
        return fortressSays("The extension synced while you were editing. Try that again.", true);
    }

    fortressState = next;
    fortressRev = written;

    renderCategories(after.categories || []);
    fortressSays(describeEdit(authored) + " The extension picks it up within a minute.");
}

// What just happened, in the words the seal prompt would have used. An edit
// that gave something up is worth naming even where nothing was charged for it.
function describeEdit(authored) {
    if (!authored) return "Saved \u2014 the fortress is stronger.";

    const given = [];
    if (authored.categoriesRemoved.length) given.push("a category removed");
    if (authored.categoriesDisabled.length) given.push("a category stood down");
    if (Object.keys(authored.sitesRemoved).length) given.push("a site unblocked");

    return given.length
        ? "Saved \u2014 " + given.join(", ") + "."
        : "Saved.";
}

// ---- The Seal: pairing ----------------------------------------------------

let codeTicker = null;

async function refreshSeal() {
    const codeEl = document.getElementById("pairCode");
    const expiryEl = document.getElementById("pairExpiry");
    const refreshBtn = document.getElementById("pairRefresh");
    if (!codeEl || !expiryEl || !refreshBtn) return;

    const status = await service.status();

    if (!status.running) {
        codeEl.textContent = "– – – – – –";
        codeEl.classList.add("is-waiting");
        expiryEl.textContent = status.bridge
            ? "Every port Dominus uses is taken, so the extension cannot reach this app."
            : "This window is running outside the app, so there is no service behind it.";
        refreshBtn.disabled = true;
        renderDevices([]);
        return;
    }

    refreshBtn.disabled = false;
    renderDevices(status.devices || []);
    await issueCode();
}

async function issueCode() {
    const codeEl = document.getElementById("pairCode");
    const expiryEl = document.getElementById("pairExpiry");

    const issued = await service.newPairingCode();
    if (!issued) return;

    codeEl.textContent = issued.code;
    codeEl.classList.remove("is-waiting");

    // A code that has quietly expired is worse than no code: the user types it,
    // is refused, and has no idea why. So the window it is good for is on
    // screen and counting down.
    if (codeTicker) clearInterval(codeTicker);

    const tick = () => {
        const left = Math.max(0, Math.round((issued.expiresAt - Date.now()) / 1000));
        if (left === 0) {
            clearInterval(codeTicker);
            codeTicker = null;
            codeEl.textContent = "– – – – – –";
            codeEl.classList.add("is-waiting");
            expiryEl.textContent = "That code has expired. Ask for a new one.";
            return;
        }
        const m = Math.floor(left / 60);
        const s = String(left % 60).padStart(2, "0");
        expiryEl.textContent = `Good for ${m}:${s}. One use.`;
    };

    tick();
    codeTicker = setInterval(tick, 1000);
}

function renderDevices(devices) {
    const list = document.getElementById("deviceList");
    const empty = document.getElementById("devicesEmpty");
    if (!list || !empty) return;

    list.textContent = "";
    empty.hidden = devices.length > 0;
    list.hidden = devices.length === 0;

    devices.forEach((device) => {
        const item = document.createElement("li");
        item.className = "device";

        const name = document.createElement("span");
        name.className = "device-name";
        // Built as a text node: a device name comes from the other side of the
        // wire and has no business being parsed as markup.
        name.textContent = device.name || device.id;

        const seen = document.createElement("span");
        seen.className = "device-seen";
        seen.textContent = device.lastSeen
            ? `last seen ${new Date(device.lastSeen).toLocaleString()}`
            : "never synced";

        item.append(name, seen);
        list.appendChild(item);
    });
}

// ---- Wiring ---------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    document.addEventListener("click", (event) => {
        const target = event.target.closest("[data-route]");
        if (!target || target.disabled) return;
        event.preventDefault();
        navigate(target.dataset.route);
    });

    const refreshBtn = document.getElementById("pairRefresh");
    if (refreshBtn) refreshBtn.addEventListener("click", issueCode);

    window.addEventListener("hashchange", () => show(routeFromHash()));

    show(routeFromHash());
});
