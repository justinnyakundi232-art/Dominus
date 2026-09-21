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
    },

    // Programs with a window open right now, for the picker. Empty rather than
    // an error when there is no bridge, which is also what a machine with
    // nothing open looks like.
    async runningApplications() {
        if (!hasBridge()) return [];
        try {
            return await window.__TAURI__.core.invoke("running_applications");
        } catch (error) {
            return [];
        }
    },

    // Counted time, for collectUsage() below; and back again if it could not
    // be written.
    async takeUsage() {
        if (!hasBridge()) return [];
        try {
            return (await window.__TAURI__.core.invoke("take_usage")) || [];
        } catch (error) {
            return [];
        }
    },

    async restoreUsage(slices) {
        if (!hasBridge() || !slices.length) return;
        try {
            await window.__TAURI__.core.invoke("restore_usage", { slices: slices });
        } catch (error) {
            /* the watcher keeps enforcing on what it had */
        }
    },

    // Seconds used today per program with an allowance, including time not yet
    // collected — what each row shows.
    async usageToday() {
        if (!hasBridge()) return {};
        try {
            return (await window.__TAURI__.core.invoke("usage_today")) || {};
        } catch (error) {
            return {};
        }
    },

    // What the watcher enforces. See pushEnforcement() below.
    async setEnforced(enforced) {
        if (!hasBridge()) return false;
        try {
            await window.__TAURI__.core.invoke("set_enforced", { enforced: enforced });
            return true;
        } catch (error) {
            return false;
        }
    }
};

// ---- Telling the watcher what to enforce ----------------------------------
//
// Rust holds a list of executables, the allowances, today's spend and the live
// unlocks, and nothing else; this window is the only thing that works them out,
// from the same state it shows, with enforcementFor() from the shared layer.
// See ../APP-LIMITS.md, "Enforcement, and where it runs".
//
// Pushed on load, after every edit, and on a timer — the timer is what carries a
// change that arrived from the extension while nobody was looking at this
// window, and what notices midnight. An unchanged picture is not re-sent,
// except after collecting time, when the push is what tells the watcher that
// what it handed over has been written.

const ENFORCEMENT_INTERVAL_MS = 20 * 1000;
let lastEnforced = "";

async function pushEnforcement(state, force) {
    let source = state;
    if (source === undefined || source === null) source = (await service.peerState()).state;

    // No state means never synced. Saying nothing leaves whatever the watcher
    // loaded from disk in force, which is the stricter of the two choices —
    // an empty push here would switch every block off on a fresh window.
    if (!source) return;

    const enforced = enforcementFor(source, todayLocal());
    const key = JSON.stringify(enforced);
    if (key === lastEnforced && !force) return;

    if (await service.setEnforced(enforced)) lastEnforced = key;
}

// ---- Collecting counted time ----------------------------------------------
//
// The watcher counts how long each program with an allowance is in front. Once
// a minute this window takes that time, writes it into the day's usage event —
// addUsage() in Sync.js, one running total per device, program and day — and
// pushes the new totals back. The extension merges the usage events like any
// others, so every device's time counts against one allowance.
//
// If the write fails twice, the time goes back to the watcher and is collected
// again next minute rather than lost. See "Counting, and who does it" in
// ../APP-LIMITS.md.

const USAGE_INTERVAL_MS = 60 * 1000;
let collecting = false;

async function collectUsage() {
    if (collecting || !hasBridge()) return;
    collecting = true;

    try {
        const slices = await service.takeUsage();
        if (!slices.length) return;

        const write = async () => {
            const peer = await service.peerState();
            if (!peer.state) return null;

            let events = peer.state.events || [];
            const now = Date.now();
            slices.forEach((slice) => {
                events = addUsage(events, peer.device, slice.exe, slice.day, slice.seconds, now);
            });

            const next = Object.assign({}, peer.state, { events: events });
            const written = await service.putState(peer.stateRev, next);
            return written === null ? null : { state: next, rev: written };
        };

        // Twice, because the likeliest reason for a refusal is a sync landing
        // at the same moment, and the second attempt reads what it brought.
        const saved = (await write()) || (await write());

        if (!saved) {
            await service.restoreUsage(slices);
            return;
        }

        // The Fortress view holds the state and revision it will write against.
        // Left alone, its next edit would be refused as if a sync had landed —
        // so it is handed what this just wrote.
        if (fortressState) {
            fortressState = saved.state;
            fortressRev = saved.rev;
        }
        await pushEnforcement(saved.state, true);
    } finally {
        collecting = false;
    }
}

// ---- Routing --------------------------------------------------------------

function routeFromHash() {
    const raw = (location.hash || "").replace(/^#\/?/, "");
    return ROUTES.includes(raw) ? raw : DEFAULT_ROUTE;
}

function refreshHookFor(route) {
    if (route === "seal") return refreshSeal;
    if (route === "keep") return refreshKeep;
    if (route === "fortress") return refreshFortress;
    if (route === "campaign") return showCampaign;
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

// Where the fortress stands today, from the synced state \u2014 the one reading both
// The Keep and The Campaign draw from, so the two views cannot disagree.
//
// standingFrom() is the extension's own, from shared/stats.js: it brings the
// streak current, so a run of clean days since the extension last synced still
// counts, and it takes the victory rate from every device's counters.
function standing(state) {
    return standingFrom(state.stats, state.counters, todayLocal());
}

function renderStanding(state) {
    const s = standing(state);

    text("keepStreak", s.currentStreak);
    text("keepStreakNote", s.longestStreak
        ? "Longest " + s.longestStreak + " " + plural(s.longestStreak, "day", "days") : "");

    text("keepResistance", s.currentResistance);
    text("keepResistanceNote", s.longestResistance
        ? "Longest " + s.longestResistance + " " + plural(s.longestResistance, "stand", "stands") : "");

    const total = s.stayFocusedCount + s.unlockCount;
    text("keepVictory", s.ratio === null ? "\u2014" : Math.round(s.ratio * 100) + "%");
    text("keepVictoryNote", total
        ? "From " + total + " " + plural(total, "moment", "moments")
        : "Nothing has tested you yet");

    const rail = document.getElementById("railStreak");
    const railLabel = document.getElementById("railStreakLabel");
    if (rail && railLabel) {
        rail.textContent = s.currentStreak;
        railLabel.textContent = s.currentStreak === 1 ? "day held" : "days held";
    }
}

// ---- The Campaign ---------------------------------------------------------
//
// Drawn by shared/trackprogress.js \u2014 the extension's own Campaign code \u2014 from
// figures built here out of the synced state. Nothing about what a held day is,
// how a square is shaded or what the tooltip says lives in this file.

const CAMPAIGN_DAYS = 26 * 7;

async function showCampaign() {
    const empty = document.getElementById("campaignEmpty");
    const content = document.getElementById("campaignContent");
    if (!empty || !content) return;

    const { state } = await service.peerState();

    if (!state || !state.stats) {
        empty.hidden = false;
        content.hidden = true;
        return;
    }

    empty.hidden = true;
    content.hidden = false;

    const today = todayLocal();
    const s = standing(state);

    // A fortress synced by a build older than the day log's backfill has no
    // inferred days in it. The extension would draw them in on its next read;
    // this draws them into a copy, so the grid matches what the extension will
    // show without this window ever writing to the state it was handed.
    let log = state.dayLog || {};
    if (!s.stats.dayLogSeeded) log = seedDayLog(JSON.parse(JSON.stringify(log)), s.stats);

    renderCampaign(s, buildDayHistory(log, s.stats, CAMPAIGN_DAYS, today));

    text("campaignMirrored", "Mirrored from the extension"
        + (state.today ? " \u00b7 last synced " + state.today : "")
        + ". Stands and unlocks from this app appear after the next sync.");

    // The rail shows the same streak, and should not wait for a visit to The Keep.
    renderStanding(state);
}

function renderToday(state) {
    const band = document.getElementById("keepToday");
    // Today here, not the day the extension last synced \u2014 a state synced
    // yesterday has nothing to say about today, and reading its "today" would
    // report yesterday's fight as this one.
    const entry = (state.dayLog || {})[todayLocal()];
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

    // Never synced with anything: there is genuinely nothing to show, and no
    // fortress to add a program to either.
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
    renderApplications(fortressState.fortress.applications || []);

    await renderSiteAvailability();
}

// Sites are the extension's to enforce; programs are this app's. So when
// nothing is paired, the two site panels are replaced by an invitation to pair
// and the programs below carry on untouched — this window enforces those on its
// own and needs nobody's permission to.
//
// Showing the last-synced site list with no extension behind it would be the
// same lie the extension's programs panel used to tell in the other direction:
// a list that says BLOCKED while nothing is blocking.
async function renderSiteAvailability() {
    const unpaired = document.getElementById("fortressSitesUnpaired");
    const categories = document.getElementById("fortressCategories");
    const manual = document.getElementById("fortressManual");
    const crossing = document.getElementById("fortressCrossing");
    if (!unpaired || !categories || !manual) return;

    const { paired } = await service.status();

    unpaired.hidden = paired;
    categories.hidden = !paired;
    manual.hidden = !paired;

    // Nothing crosses to a browser that is not listening, so the line promising
    // it would within a minute has to go with them.
    if (crossing) crossing.hidden = !paired;
}

// ---- What the controls mean ----------------------------------------------
//
// "Stand down" and "Remove" sit side by side and are easy to mistake for each
// other: one is off-for-now, the other is gone. Every control says which on
// hover, in the same words wherever it appears, including the extension.

const HELP = {
    category: {
        standDown: "Stand down: switch this category off for now. Its sites stay in the list"
            + " but stop being blocked until you take it back up. Nothing is deleted.",
        takeUp: "Take up: switch this category back on. Its sites are blocked again"
            + " within a minute.",
        remove: "Remove: delete this category and its site list for good. To block these"
            + " sites again you would have to rebuild it.",
        stoodDown: "Stood down: switched off for now, not deleted. Take it up again to"
            + " resume blocking its sites."
    },
    application: {
        standDown: "Stand down: switch this program off for now. It stays in the list but"
            + " stops being blocked until you take it back up. Nothing is deleted.",
        takeUp: "Take up: start blocking this program again, straight away.",
        remove: "Remove: take this program out of your fortress entirely. To block it"
            + " again, add it from Block a program.",
        stoodDown: "Stood down: switched off for now, not deleted. Take it up again to"
            + " resume blocking it.",
        allowance: "Minutes a day this program can be the window in front before Dominus"
            + " puts it away. 0 blocks it outright. Lowering it is always free; raising it"
            + " takes the seal on a sealed fortress.",
        warn: "How many minutes before today's time runs out to show a reminder in the"
            + " corner. 0 for no reminder.",
        pickerMinutes: "Minutes a day. Leave it empty to block the program outright."
    },
    site: (site) => "Stop blocking " + site + ". It is removed from this category.",
    sealed: "Sealed — taking a defence down needs your password, and that prompt is"
        + " in the extension. Open The Fortress in Chrome to do it."
};

// A control that would take a defence down, on a sealed fortress.
//
// Not `disabled`. Chromium — which this window is — does not reliably show a
// tooltip on a disabled button, so the one moment the explanation matters most
// (someone skimming past the notice, meeting the not-allowed cursor) is the
// moment it would not appear. So the button looks disabled and says why on
// hover, and a click says it again in the status line rather than doing
// nothing, which is the other thing that reads as broken.
//
// The seal's reason is added under what the button does, not in place of it —
// someone meeting "Stand down" for the first time on a sealed fortress still
// needs to know what it would have done.
function holdForSeal(button) {
    button.setAttribute("aria-disabled", "true");
    button.classList.add("is-sealed");
    button.title = (button.title ? button.title + "\n\n" : "") + HELP.sealed;
}

// The other way: a control that was held and no longer needs to be.
function releaseSeal(button, title) {
    button.removeAttribute("aria-disabled");
    button.classList.remove("is-sealed");
    button.title = title;
}

// Wires a click, unless the control is held for the seal.
function onPress(button, action) {
    button.addEventListener("click", (event) => {
        if (button.getAttribute("aria-disabled") === "true") {
            event.preventDefault();
            fortressSays(HELP.sealed, true);
            return;
        }
        action();
    });
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
        if (!category.enabled) count.title = HELP.category.stoodDown;

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
        drop.title = HELP.site(site);
        drop.setAttribute("aria-label", "Stop blocking " + site);
        if (sealed) holdForSeal(drop);
        onPress(drop, () => removeSite(category.id, site));

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
    toggle.title = category.enabled ? HELP.category.standDown : HELP.category.takeUp;
    // Switching a category back on is strengthening. Switching it off is not.
    if (sealed && category.enabled) holdForSeal(toggle);
    onPress(toggle, () => toggleCategory(category.id));
    actions.appendChild(toggle);

    // A permanent category cannot be removed at all — that is what permanent
    // means, and it means the same thing in both windows.
    if (!category.permanent) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn-quiet is-breach";
        remove.textContent = "REMOVE";
        remove.title = HELP.category.remove;
        // Held even for one already stood down: removing it still writes a
        // weakening record, and commitEdit() refuses any record on a sealed
        // fortress. A button that looked free and was then refused is worse
        // than one that says up front where to go.
        if (sealed) holdForSeal(remove);
        onPress(remove, () => removeCategory(category.id));
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

// ---- Applications ---------------------------------------------------------
//
// The only place in Dominus a program can be added. The browser cannot see one,
// so the extension shows this list and nothing more.

function renderApplications(applications) {
    const list = document.getElementById("applicationList");
    const note = document.getElementById("applicationsNote");
    if (!list || !note) return;

    list.textContent = "";
    const sealed = fortressIsSealed();

    note.textContent = applications.length
        ? "Put away when you open them, with the same gate, task and cooldown as a site."
        : "No programs blocked. The browser cannot see these, so this is the only"
            + " place they are added.";

    applications.forEach((application) => {
        const item = document.createElement("li");
        item.className = "category" + (application.enabled ? "" : " is-down");

        const head = document.createElement("div");
        head.className = "category-head";

        const glyph = document.createElement("span");
        glyph.className = "category-glyph";
        glyph.setAttribute("aria-hidden", "true");
        glyph.textContent = "▣";

        const name = document.createElement("span");
        name.className = "category-name";
        name.textContent = application.name || application.exe;

        const entry = normalizeApplication(application) || application;

        // The executable, because it is what is actually matched and the name
        // is only a label the user chose — and the rule it is under.
        const exe = document.createElement("span");
        exe.className = "category-count";
        exe.textContent = application.enabled
            ? application.exe
                + (entry.allowanceMinutes > 0 ? " · " + formatAllowance(entry.allowanceMinutes) + " a day" : " · blocked")
                + (application.permanent ? " · permanent" : "")
            : "stood down";
        if (!application.enabled) exe.title = HELP.application.stoodDown;

        head.append(glyph, name, exe);
        item.appendChild(head);

        item.appendChild(renderAllowance(entry));

        const actions = document.createElement("div");
        actions.className = "category-actions";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "btn-quiet";
        toggle.textContent = application.enabled ? "STAND DOWN" : "TAKE UP";
        toggle.title = application.enabled ? HELP.application.standDown : HELP.application.takeUp;
        if (sealed && application.enabled) holdForSeal(toggle);
        onPress(toggle, () => toggleApplication(application.id));
        actions.appendChild(toggle);

        if (!application.permanent) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "btn-quiet is-breach";
            remove.textContent = "REMOVE";
            remove.title = HELP.application.remove;
            if (sealed) holdForSeal(remove);
            onPress(remove, () => removeApplication(application.id));
            actions.appendChild(remove);
        }

        item.appendChild(actions);
        list.appendChild(item);
    });
}

// How long a program may be in front each day, how much of that is gone, and
// when to be reminded. Edited in place and saved with its own button, so a
// half-typed number is never committed.
function renderAllowance(entry) {
    const row = document.createElement("div");
    row.className = "allowance";

    if (entry.enabled && entry.allowanceMinutes > 0) {
        const used = document.createElement("span");
        used.className = "allowance-used";
        used.dataset.usageExe = entry.exe;
        used.dataset.allowanceMinutes = String(entry.allowanceMinutes);
        used.textContent = usedLine(savedUsage(entry.exe), entry.allowanceMinutes);
        row.appendChild(used);
    }

    const minutes = numberField(entry.allowanceMinutes, 0, 1440, 5, HELP.application.allowance);
    const warn = numberField(entry.warnMinutes, 0, 60, 1, HELP.application.warn);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-quiet";
    save.textContent = "SAVE";
    save.title = "Save the allowance and the reminder for this program.";
    save.disabled = true;

    const changed = () => {
        save.disabled = Number(minutes.value) === entry.allowanceMinutes
            && Number(warn.value) === entry.warnMinutes;

        // More time is a weakening. On a sealed fortress say so as it is
        // typed, not after the click — the same held look and hover text as
        // every other control that needs the extension.
        releaseSeal(save, "Save the allowance and the reminder for this program.");
        if (fortressIsSealed() && Number(minutes.value) > entry.allowanceMinutes) holdForSeal(save);
    };
    minutes.addEventListener("input", changed);
    warn.addEventListener("input", changed);

    const submit = () => {
        if (save.disabled) return;
        if (save.getAttribute("aria-disabled") === "true") return fortressSays(HELP.sealed, true);
        setAllowance(entry.id, minutes.value, warn.value);
    };
    save.addEventListener("click", submit);
    [minutes, warn].forEach((field) => field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
    }));

    row.append(
        fieldLabel("Allowed", minutes, "min a day", HELP.application.allowance),
        fieldLabel("Warn", warn, "min before", HELP.application.warn),
        save
    );
    return row;
}

function numberField(value, min, max, step, help) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.title = help;
    input.className = "allowance-input";
    return input;
}

function fieldLabel(before, input, after, help) {
    const label = document.createElement("label");
    label.className = "allowance-field";
    label.title = help;
    // Wrapped rather than a bare text node so the two fields' inputs line up in
    // one column when they stack. See .field-name.
    const name = document.createElement("span");
    name.className = "field-name";
    name.textContent = before;
    label.append(name, input, document.createTextNode(" " + after));
    return label;
}

// Today's use as last written to the event log — every device's time, and this
// one's up to the last collection. The live figure replaces it within seconds.
function savedUsage(exe) {
    const events = (fortressState && fortressState.events) || [];
    return deriveUsage(events, todayLocal())[exe] || 0;
}

function usedLine(seconds, allowanceMinutes) {
    const used = Math.min(allowanceMinutes, Math.floor(seconds / 60));
    return used >= allowanceMinutes
        ? "Today's " + formatAllowance(allowanceMinutes) + " is used up."
        : formatAllowance(used) + " of " + formatAllowance(allowanceMinutes) + " used today.";
}

// The figures on screen, kept current from what the watcher is counting. Only
// the text of each "used today" line changes, so a number being typed is left
// alone.
const USAGE_REFRESH_MS = 5000;

async function refreshUsageLines() {
    const view = document.getElementById("view-fortress");
    if (!view || !view.classList.contains("is-active") || document.hidden) return;

    const lines = document.querySelectorAll("[data-usage-exe]");
    if (!lines.length) return;

    const live = await service.usageToday();
    lines.forEach((line) => {
        const exe = line.dataset.usageExe;
        const seconds = exe in live ? live[exe] : savedUsage(exe);
        line.textContent = usedLine(seconds, Number(line.dataset.allowanceMinutes));
    });
}

function setAllowance(id, minutesRaw, warnRaw) {
    const next = applicationsWith(id, (application) => Object.assign({}, application, {
        allowanceMinutes: Number(minutesRaw),
        warnMinutes: Number(warnRaw)
    }));
    // Read back through the normaliser, so what is saved is what will be
    // enforced — a typed 7.5 becomes 8, a typed 5000 a whole day.
    commitEdit({ applications: normalizeApplicationList(next) });
}

async function togglePicker() {
    const picker = document.getElementById("applicationPicker");
    const button = document.getElementById("pickerToggle");
    if (!picker || !button) return;

    if (!picker.hidden) {
        picker.hidden = true;
        button.textContent = "BLOCK A PROGRAM";
        stopPickerRefresh();
        return;
    }

    button.textContent = "CLOSE";
    picker.hidden = false;
    pickerShown = "";
    await renderPicker();
    startPickerRefresh();
}

// The list is a snapshot of what is open, and what is open changes while the
// picker is on screen — close Chrome, open Notepad, come back. Asking once, on
// open, left it showing a program that had already gone and missing the one
// the user had just opened to block. So it asks again every two seconds for as
// long as it is visible, and again the moment the window regains focus.
const PICKER_REFRESH_MS = 2000;
let pickerTimer = null;
// What the list last drew, so an unchanged answer does not rebuild it — a
// rebuild every two seconds would steal the hover and flicker under the cursor.
let pickerShown = "";

function pickerIsVisible() {
    const picker = document.getElementById("applicationPicker");
    const view = document.getElementById("view-fortress");
    return Boolean(picker && !picker.hidden && view && view.classList.contains("is-active")
        && !document.hidden);
}

function startPickerRefresh() {
    stopPickerRefresh();
    pickerTimer = setInterval(() => {
        if (pickerIsVisible()) renderPicker();
    }, PICKER_REFRESH_MS);
}

function stopPickerRefresh() {
    if (pickerTimer) clearInterval(pickerTimer);
    pickerTimer = null;
}

async function renderPicker() {
    const list = document.getElementById("pickerList");
    if (!list || !fortressState) return;

    const held = fortressState.fortress.applications || [];

    // Protected programs are left out rather than shown disabled. Offering the
    // shell or Task Manager with a greyed-out button invites a question whose
    // only answer is "because it would lock you out".
    const running = (await service.runningApplications())
        .filter((entry) => !isProtectedExecutable(entry.exe));

    // Asked before clearing, not after: clearing first left the list empty for
    // the length of the round trip, which reads as the programs vanishing.
    const shown = JSON.stringify([
        running.map((entry) => [entry.exe, entry.title]),
        held.filter((a) => a.enabled).map((a) => a.id)
    ]);
    if (shown === pickerShown) return;
    pickerShown = shown;

    list.textContent = "";

    if (!running.length) {
        const empty = document.createElement("li");
        empty.className = "picker-empty";
        empty.textContent = hasBridge()
            ? "Nothing to offer. Open the program you want to block, then look again."
            : "The picker needs the desktop app — it cannot list programs from a browser.";
        list.appendChild(empty);
        return;
    }

    running.forEach((entry) => {
        const item = document.createElement("li");
        item.className = "picker-item";

        const label = document.createElement("span");
        label.className = "picker-label";

        const name = document.createElement("span");
        name.className = "picker-name";
        name.textContent = applicationDisplayName(entry.exe);

        const detail = document.createElement("span");
        detail.className = "picker-detail";
        // A window title can be anything — a document name, a chat — and it
        // is shown only to help recognise the program. It is never stored.
        detail.textContent = entry.exe + " — " + entry.title;

        label.append(name, detail);

        const inFortress = findApplication(held, entry.exe);
        const already = Boolean(inFortress && inFortress.enabled);

        const actions = document.createElement("span");
        actions.className = "picker-actions";

        // Minutes a day, set as the program is added. Adding one with time
        // already allowed is not a weakening — it was not in the fortress
        // before — where adding it blocked and then raising it would ask for
        // the seal on a sealed fortress.
        const minutes = document.createElement("input");
        minutes.type = "number";
        minutes.min = "0";
        minutes.max = "1440";
        minutes.step = "5";
        minutes.placeholder = "min/day";
        minutes.className = "allowance-input";
        minutes.title = HELP.application.pickerMinutes;
        minutes.setAttribute("aria-label", "Minutes a day for " + applicationDisplayName(entry.exe));
        minutes.hidden = already;

        const add = document.createElement("button");
        add.type = "button";
        add.className = "btn-quiet";
        add.textContent = already ? "ADDED" : "BLOCK";
        add.disabled = already;

        minutes.addEventListener("input", () => {
            add.textContent = Number(minutes.value) > 0 ? "LIMIT" : "BLOCK";
        });
        const submit = () => addApplication(entry.exe, minutes.value);
        add.addEventListener("click", submit);
        minutes.addEventListener("keydown", (event) => {
            if (event.key === "Enter") submit();
        });

        actions.append(minutes, add);
        item.append(label, actions);
        list.appendChild(item);
    });
}

function applicationsWith(id, change) {
    return (fortressState.fortress.applications || []).map((application) => (
        application.id === id ? change(application) : application
    ));
}

function addApplication(exe, minutesRaw) {
    const entry = normalizeApplication({ exe: exe, enabled: true, allowanceMinutes: Number(minutesRaw) || 0 });
    if (!entry) return fortressSays("Dominus will not block that program.", true);

    const held = fortressState.fortress.applications || [];
    const existing = findApplication(held, exe);

    // Already there but stood down: taking it back up is what the user meant.
    // Its allowance is left as it was — changing that is its own edit on the
    // row, and raising it may need the seal.
    if (existing) {
        if (existing.enabled) return fortressSays(existing.name + " is already in the fortress.");
        return commitEdit({ applications: applicationsWith(existing.id, (a) => Object.assign({}, a, { enabled: true })) });
    }

    commitEdit({ applications: held.concat([entry]) });
}

function toggleApplication(id) {
    commitEdit({ applications: applicationsWith(id, (application) => Object.assign({}, application, {
        enabled: !application.enabled,
        permanent: application.enabled ? false : application.permanent
    })) });
}

function removeApplication(id) {
    commitEdit({
        applications: (fortressState.fortress.applications || []).filter((a) => a.id !== id)
    });
}

// ---- Editing --------------------------------------------------------------

function categoriesWith(id, change) {
    return (fortressState.fortress.categories || []).map((category) => (
        category.id === id ? change(category) : category
    ));
}

function toggleCategory(id) {
    commitEdit({ categories: categoriesWith(id, (category) => Object.assign({}, category, {
        enabled: !category.enabled,
        // Permanence cannot outlive being switched off — the same rule
        // normalizeCategoryList() enforces and applyAuthored() re-applies.
        permanent: category.enabled ? false : category.permanent
    })) });
}

function addSite(id, typed) {
    const site = normalizeDomain(typed);
    if (!site) return fortressSays("That is not a site.", true);

    const category = (fortressState.fortress.categories || []).find((c) => c.id === id);
    if (category && (category.sites || []).includes(site)) {
        return fortressSays(site + " is already blocked there.");
    }

    commitEdit({ categories: categoriesWith(id, (c) => Object.assign({}, c, {
        sites: (c.sites || []).concat([site])
    })) });
}

function removeSite(id, site) {
    commitEdit({ categories: categoriesWith(id, (category) => Object.assign({}, category, {
        sites: (category.sites || []).filter((held) => held !== site)
    })) });
}

function removeCategory(id) {
    commitEdit({ categories: (fortressState.fortress.categories || []).filter((c) => c.id !== id) });
}

// Stamps and writes an edit. `change` is the parts of the fortress that moved —
// `categories`, `applications`, or both — each as the whole list, after.
//
// Nothing else in this file writes: every edit above builds a list and arrives
// here, for the same reason every edit in the extension goes through
// commitFortress() — a rule that lives in one place is a rule that exists.
async function commitEdit(change) {
    const before = fortressState.fortress;
    const after = Object.assign({}, before, change);

    const authored = describeAuthoredWeakening(before, after);

    if (authored && fortressIsSealed()) {
        // Should be unreachable — every control that could weaken is held on a
        // sealed fortress. Checked anyway, because "the button was greyed out"
        // is not an enforcement boundary.
        return fortressSays(HELP.sealed, true);
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
    renderApplications(after.applications || []);

    // Programs are enforced here, not in the browser, so an application edit
    // takes effect now — only the record waits for the next tick.
    await pushEnforcement(next);

    const picker = document.getElementById("applicationPicker");
    if (picker && !picker.hidden) await renderPicker();

    const reach = ("applications" in change)
        ? " It takes effect now; the extension records it within a minute."
        : " The extension picks it up within a minute.";
    fortressSays(describeEdit(authored) + reach);
}

// What just happened, in the words the seal prompt would have used. An edit
// that gave something up is worth naming even where nothing was charged for it.
function describeEdit(authored) {
    if (!authored) return "Saved \u2014 the fortress is stronger.";

    const given = [];
    if (authored.categoriesRemoved.length) given.push("a category removed");
    if (authored.categoriesDisabled.length) given.push("a category stood down");
    if (Object.keys(authored.sitesRemoved).length) given.push("a site unblocked");
    if (authored.applicationsRemoved.length) given.push("a program removed");
    if (authored.applicationsDisabled.length) given.push("a program stood down");
    if (Object.keys(authored.allowancesRaised || {}).length) given.push("a program given more time");

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

    const pickerBtn = document.getElementById("pickerToggle");
    if (pickerBtn) pickerBtn.addEventListener("click", togglePicker);

    // Coming back to this window is the usual moment the list is stale — the
    // user has just been off opening the program they want to block. It is
    // also the usual moment a pairing has changed, because forgetting the app
    // is done over in the browser.
    window.addEventListener("focus", () => {
        if (pickerIsVisible()) renderPicker();
        renderSiteAvailability();
    });

    window.addEventListener("hashchange", () => show(routeFromHash()));

    show(routeFromHash());

    // Whatever view is open, and whether or not the window is ever shown: the
    // watcher is enforcing on the strength of what this sends it.
    pushEnforcement();
    setInterval(() => pushEnforcement(), ENFORCEMENT_INTERVAL_MS);

    // And the time it counts is collected, whether or not anyone is looking.
    setInterval(() => collectUsage(), USAGE_INTERVAL_MS);

    // The "used today" lines, while The Fortress is on screen.
    setInterval(() => refreshUsageLines(), USAGE_REFRESH_MS);

    // And whether there is still an extension on the other end. The one thing
    // this window must never do is the thing it did before: go on showing a
    // fortress nobody is updating as though it were live. Cheap — a local
    // call, no network — and it rides the interval that already exists.
    setInterval(() => renderSiteAvailability(), ENFORCEMENT_INTERVAL_MS);
});
