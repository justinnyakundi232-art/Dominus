// app.js — the desktop window's shell.
//
// Deliberately the same shape as the extension's App.js: hash routing, views
// hidden rather than rebuilt, a refresh hook per view. The two surfaces should
// behave the same way, not merely look alike.
//
// Phase 1 scope: the frame, and pairing. Everything this window can show, it
// shows because the extension told it — so until the two are paired, every view
// is an empty state, and the honest job of this file is to make that first run
// legible rather than to hide it.
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

    // The fortress as the extension last sent it, or null before any sync.
    async mirrored() {
        if (!hasBridge()) return null;
        try {
            return await window.__TAURI__.core.invoke("mirrored_state");
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

    const state = await service.mirrored();

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
