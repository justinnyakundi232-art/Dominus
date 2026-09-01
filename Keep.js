// Keep.js — The Keep, the dashboard the shell opens on.
//
// This is the one view with no page behind it. Dominus has never had a surface
// that answers "where do I stand right now" — the popup is a menu, the campaign
// is a report, and the two things that are actually *live* (what is blocked,
// and what is currently unlocked) were visible nowhere at all.
//
// Everything here is read-only. Nothing on this view changes the fortress; the
// links hand off to the view that does.

// The open-gate countdown. Held at module scope so a second refresh replaces it
// rather than stacking a second ticker on the first.
let keepGateTicker = null;

// Called by the router every time the Keep is shown. See refreshHookFor() in
// App.js. Safe to call repeatedly: every render replaces its own content.
function refreshKeep() {
    renderKeepStanding();
    renderKeepToday();
    renderKeepDefences();
    renderKeepSeal();
    startKeepGateTicker();
}

// ---- Standing -------------------------------------------------------------

function renderKeepStanding() {
    return getStats().then((stats) => {
        setKeepStat("keepStreak", stats.currentStreak);
        setKeepText("keepStreakNote", stats.longestStreak > 0
            ? `Longest ${stats.longestStreak} ${plural(stats.longestStreak, "day", "days")}`
            : "");

        setKeepStat("keepResistance", stats.currentResistance);
        setKeepText("keepResistanceNote", stats.longestResistance > 0
            ? `Longest ${stats.longestResistance} ${plural(stats.longestResistance, "stand", "stands")}`
            : "");

        // The two streaks measure different things — days held versus choices
        // made — so each carries its own unit here, exactly as the campaign
        // labels them. A bare pair of numbers reads as one figure stated twice.
        const total = stats.stayFocusedCount + stats.unlockCount;
        setKeepStat("keepVictory", stats.ratio === null
            ? "—"
            : `${Math.round(stats.ratio * 100)}%`);
        setKeepText("keepVictoryNote", total === 0
            ? "Nothing has tested you yet"
            : `From ${total} ${plural(total, "moment", "moments")}`);
    });
}

function setKeepStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function setKeepText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function plural(n, one, many) {
    return n === 1 ? one : many;
}

// ---- Today ----------------------------------------------------------------
//
// The same three states the history grid uses, said in words. Held, slipped and
// untested are kept distinct here for the reason they are kept distinct there:
// a day nothing asked anything of you is not a day you won.

function renderKeepToday() {
    return getDayHistory(1).then((history) => {
        const today = history[history.length - 1];
        const entry = today && today.entry;
        const state = today ? today.state : null;

        const stateEl = document.getElementById("keepTodayState");
        const detailEl = document.getElementById("keepTodayDetail");
        const band = document.getElementById("keepToday");
        if (!stateEl || !detailEl || !band) return;

        band.classList.remove("is-held", "is-slipped");

        if (state === DAY_SLIPPED) {
            band.classList.add("is-slipped");
            stateEl.textContent = "A gate gave way today.";
            detailEl.textContent = describeKeepSlip(entry);
            return;
        }

        if (state === DAY_HELD) {
            band.classList.add("is-held");
            const n = entry.stands;
            stateEl.textContent = `You have held the line ${n} ${plural(n, "time", "times")} today.`;
            detailEl.textContent = "Every one of those was a choice.";
            return;
        }

        stateEl.textContent = "Nothing has tested you today.";
        detailEl.textContent =
            "An untested day keeps your streak — it just wasn't a fight.";
    });
}

// The first slip and what gave way. That pairing is the useful one: the time
// tends to explain the day better than the count does.
function describeKeepSlip(entry) {
    const domains = Object.keys(entry.sites || {});
    const when = entry.firstSlip ? ` at ${entry.firstSlip}` : "";

    if (!domains.length) {
        return `First unlock${when}.`;
    }

    if (domains.length === 1) {
        return `${domains[0]}${when}.`;
    }

    return `${domains[0]}${when}, and ${domains.length - 1} other ${plural(domains.length - 1, "site", "sites")}.`;
}

// ---- What stands ----------------------------------------------------------

function renderKeepDefences() {
    return loadCategories().then(({ categories, manualSites }) => {
        const blocked = computeBlockedSites(categories, manualSites);
        const enabled = categories.filter((category) => category.enabled);

        const el = document.getElementById("keepDefences");
        if (!el) return;

        if (!blocked.length) {
            el.textContent = "Nothing is blocked yet. The fortress has no walls.";
            return;
        }

        const sites = `${blocked.length} ${plural(blocked.length, "site", "sites")} blocked`;
        const cats = enabled.length
            ? ` across ${enabled.length} ${plural(enabled.length, "category", "categories")}`
            : "";
        const manual = manualSites.length
            ? `, ${manualSites.length} of them by hand`
            : "";

        el.textContent = `${sites}${cats}${manual}.`;
    });
}

// ---- Gates standing open --------------------------------------------------
//
// Sites inside a live temporary unlock window. Hidden when there are none,
// because that is the normal state and a permanently empty panel teaches the
// eye to skip the place where something important will one day appear.

function renderKeepGates() {
    return new Promise((resolve) => {
        chrome.storage.local.get(["tempUnlocks"], (result) => {
            const unlocks = result.tempUnlocks || {};
            const now = Date.now();

            const open = Object.keys(unlocks)
                .map((domain) => ({ domain: domain, expiry: Number(unlocks[domain]) || 0 }))
                .filter((gate) => gate.expiry > now)
                .sort((a, b) => a.expiry - b.expiry);

            const band = document.getElementById("keepOpenGates");
            const list = document.getElementById("keepGateList");
            if (!band || !list) return resolve(open);

            band.hidden = open.length === 0;
            list.textContent = "";

            open.forEach((gate) => {
                const item = document.createElement("li");
                item.className = "keep-gate";

                const name = document.createElement("span");
                name.className = "keep-gate-name";
                // Built as a text node rather than innerHTML: the domain came
                // from a URL the user visited, and has no business being parsed
                // as markup. Same rule the blocked page's category badge keeps.
                name.textContent = gate.domain;

                const left = document.createElement("span");
                left.className = "keep-gate-left";
                left.textContent = formatHuman(Math.ceil((gate.expiry - now) / 1000)) + " left";

                item.appendChild(name);
                item.appendChild(left);
                list.appendChild(item);
            });

            resolve(open);
        });
    });
}

// Ticks the countdown while the Keep is on screen, and stops as soon as it
// isn't. A dashboard that shows "14 minutes left" frozen from whenever you last
// looked is worse than one that shows nothing.
function startKeepGateTicker() {
    if (keepGateTicker) clearInterval(keepGateTicker);

    renderKeepGates();

    keepGateTicker = setInterval(() => {
        const view = document.getElementById("view-keep");
        if (!view || !view.classList.contains("is-active")) {
            clearInterval(keepGateTicker);
            keepGateTicker = null;
            return;
        }

        renderKeepGates();
    }, 1000);
}

// ---- The seal -------------------------------------------------------------

function renderKeepSeal() {
    return loadSeal().then((seal) => {
        const el = document.getElementById("keepSealState");
        if (!el) return;

        if (!seal.enabled) {
            el.textContent =
                "No seal set. Anything that weakens your fortress goes through a ten-second gate.";
            return;
        }

        if (seal.recovery) {
            el.textContent = "Set — but a recovery is running, and will lift it.";
            return;
        }

        el.textContent = "Set. Taking a defence down asks for it first.";
    });
}
