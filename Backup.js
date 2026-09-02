// Backup.js — export and import a fortress.
//
// Dominus keeps everything in chrome.storage.local, which Chrome never syncs
// and never backs up. Until this file existed there was no way to get a
// fortress out of a browser: reinstalling Chrome, switching machines, a
// corrupted profile or removing the extension for a moment took the whole
// record with it, silently and with no way back. For a product whose value is
// an accumulating history, that was the wrong thing to be missing.
//
// Dependency-free classic script, same contract as the rest of the shared
// layer. It reads Sync.js (mergePeerState, applyMerge), Stats.js, Tasks.js,
// Categories.js and Seal.js inside functions.
//
// ---------------------------------------------------------------------------
// Design note — a backup is a peer
//
// Importing does NOT overwrite what is here. It runs the file through
// mergePeerState() — the same function that will reconcile the extension with
// the desktop app — treating the backup as another device that has been offline
// for a while. Three things follow from that, and all three are the behaviour
// you want from a restore:
//
//   1. It cannot take a defence down. The merge is strengthen-wins, and a
//      weakening only applies when it arrives with an authored record saying
//      the user deliberately made it. A backup carries none, so importing an
//      old file can never quietly unblock something you have since blocked.
//
//   2. It cannot lose anything. Counters union per device, the day log merges
//      per field, and the event log is a set union by id — so importing a
//      backup into a fortress that has kept running since gives you both
//      histories rather than whichever was written last.
//
//   3. Importing the same file twice does nothing the second time. The merge
//      is idempotent, which is what makes "did that work? let me try again"
//      safe rather than a way to double your own numbers.
//
// The cost of that choice, stated plainly on the panel: a restore adds, so it
// cannot be used to roll the fortress back. Deliberately removing a category
// and then importing an older backup will bring it back. Given the two
// directions this could fail in — silently restoring a defence you meant to
// remove, or silently removing one you meant to keep — this is the right one to
// get wrong.

const BACKUP_FORMAT = "dominus-fortress-backup";
const BACKUP_FORMAT_VERSION = 1;

// ---- Export ---------------------------------------------------------------

// Everything worth carrying between browsers, and nothing that would break if
// it were carried.
//
// Two things are deliberately left out:
//
//   syncDevice — a device's identity must never be copied. Two devices sharing
//   an id would have their per-device counters merged as one, and every stand
//   recorded on the second would overwrite rather than add to the first.
//   The importing browser keeps its own id and gains the backup's counters
//   alongside it, which is what makes the totals come out right.
//
//   tempUnlocks — a live unlock window is session state, not history. Carrying
//   one across would hand a machine access it never paid the cooldown for.
//   escalationState is left out for the same reason and costs nothing: since
//   1.11 it is derived from unlock events, which ARE in the file.
function buildFortressBackup() {
    return readPeerState().then((state) => ({
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        exportedBy: chrome.runtime.getManifest().version,

        today: state.today,
        events: state.events,
        counters: state.counters,
        fortressRev: state.fortressRev,
        stats: state.stats,
        dayLog: state.dayLog,
        fortress: state.fortress,
        seal: state.seal,
        sealAttempts: state.sealAttempts
    }));
}

function backupFilename() {
    return `dominus-fortress-${todayLocal()}.json`;
}

// Hands the file to the browser's own download flow. No `downloads` permission
// is needed: this is an ordinary anchor click on a blob, started by the user.
function downloadFortressBackup() {
    return buildFortressBackup().then((backup) => {
        const blob = new Blob([JSON.stringify(backup, null, 2)], {
            type: "application/json"
        });
        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = url;
        link.download = backupFilename();
        document.body.appendChild(link);
        link.click();
        link.remove();

        // Freed on the next turn rather than immediately: revoking synchronously
        // can cancel the download in some builds before it has been read.
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        return backup;
    });
}

// ---- Import ---------------------------------------------------------------

// Nothing from a file is trusted. Every field is put back through the same
// normalizers storage goes through, so a hand-edited or truncated backup can
// only ever produce a valid fortress — or be rejected outright.
function normalizeBackup(raw) {
    if (!raw || typeof raw !== "object") {
        throw new Error("That file isn't a Dominus backup.");
    }

    if (raw.format !== BACKUP_FORMAT) {
        throw new Error("That file isn't a Dominus backup.");
    }

    if (Number(raw.formatVersion) > BACKUP_FORMAT_VERSION) {
        throw new Error(
            "That backup was made by a newer version of Dominus than this one."
        );
    }

    const fortress = raw.fortress || {};

    return {
        today: typeof raw.today === "string" ? raw.today : todayLocal(),
        events: normalizeEventLog(raw.events),
        counters: normalizeSyncMeta({ counters: raw.counters }).counters,
        fortressRev: Math.max(0, Math.round(Number(raw.fortressRev) || 0)),
        stats: normalizeStats(raw.stats),
        dayLog: normalizeBackupDayLog(raw.dayLog),

        fortress: {
            // normalizeCategoryList returns null for anything that isn't an
            // array, which would silently drop the whole fortress — so an
            // unreadable list becomes an empty one instead, and the merge
            // simply has nothing to contribute.
            categories: normalizeCategoryList(fortress.categories) || [],
            manualSites: Array.isArray(fortress.manualSites)
                ? fortress.manualSites.map(normalizeDomain).filter(Boolean)
                : [],
            task: fortress.task || null,
            cooldown: normalizeCooldown(fortress.cooldown)
        },

        seal: normalizeSeal(raw.seal),
        sealAttempts: normalizeSealAttempts(raw.sealAttempts),

        // A backup never carries a weakening. It is a record of what a fortress
        // held, not an instruction to take anything down — see the design note.
        authored: null,
        escalation: {},
        tempUnlocks: {}
    };
}

function normalizeBackupDayLog(raw) {
    if (!raw || typeof raw !== "object") return {};

    const log = {};
    Object.keys(raw).forEach((date) => {
        // Keys are local dates. Anything else is not a day and is dropped
        // rather than carried into the history grid.
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            log[date] = normalizeDayEntry(raw[date]);
        }
    });

    return log;
}

// Merges a backup into this fortress and writes the result.
//
// Resolves a short summary of what actually changed, because "Imported." tells
// the user nothing about whether the file was the one they meant.
function importFortressBackup(raw) {
    const backup = normalizeBackup(raw);

    return readPeerState().then((mine) => {
        const merged = mergePeerState(mine, backup, Date.now());

        return applyMerge(merged).then(() => ({
            imported: true,
            summary: describeImport(mine, merged)
        }));
    });
}

function describeImport(before, after) {
    const parts = [];

    const newEvents = after.events.length - before.events.length;
    if (newEvents > 0) {
        parts.push(`${newEvents} ${newEvents === 1 ? "record" : "records"} added`);
    }

    const newDays = Object.keys(after.dayLog).length - Object.keys(before.dayLog).length;
    if (newDays > 0) {
        parts.push(`${newDays} ${newDays === 1 ? "day" : "days"} of history`);
    }

    const beforeBlocked = computeBlockedSites(
        before.fortress.categories, before.fortress.manualSites
    ).length;
    const afterBlocked = computeBlockedSites(
        after.fortress.categories, after.fortress.manualSites
    ).length;
    if (afterBlocked > beforeBlocked) {
        parts.push(`${afterBlocked - beforeBlocked} more sites blocked`);
    }

    if (after.stats.longestStreak > before.stats.longestStreak) {
        parts.push(`longest streak now ${after.stats.longestStreak} days`);
    }

    if (!parts.length) {
        return "Nothing new — this fortress already had everything in that file.";
    }

    return parts.join(", ") + ".";
}

function readBackupFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onerror = () => reject(new Error("That file couldn't be read."));
        reader.onload = () => {
            try {
                resolve(JSON.parse(reader.result));
            } catch (error) {
                reject(new Error("That file isn't valid JSON."));
            }
        };

        reader.readAsText(file);
    });
}

// ---- The panel ------------------------------------------------------------

function renderBackupPanel() {
    const exportBtn = document.getElementById("backupExport");
    const importBtn = document.getElementById("backupImport");
    const input = document.getElementById("backupFile");
    const status = document.getElementById("backupStatus");

    if (!exportBtn || !importBtn || !input || !status) return;

    exportBtn.addEventListener("click", () => {
        setBackupStatus(status, "");

        downloadFortressBackup()
            .then(() => setBackupStatus(status, `Saved as ${backupFilename()}.`))
            .catch(() => setBackupStatus(status, "Couldn't build the backup.", true));
    });

    // The real input is hidden because a browser file picker cannot be styled,
    // and an unstyled one beside the gold buttons looks like a bug.
    importBtn.addEventListener("click", () => input.click());

    input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) return;

        setBackupStatus(status, "Reading…");

        readBackupFile(file)
            .then(importFortressBackup)
            .then((result) => {
                setBackupStatus(status, result.summary);
                refreshAfterImport();
            })
            .catch((error) => setBackupStatus(status, error.message, true))
            // Cleared either way, so choosing the same file twice still fires
            // a change event and the user isn't left wondering why nothing
            // happened on a retry.
            .then(() => { input.value = ""; });
    });
}

function setBackupStatus(el, text, isError) {
    el.textContent = text;
    el.classList.toggle("is-error", isError === true);
}

// An import can change every figure in the app, so the views that read storage
// are repainted rather than left showing what was true a moment ago. The
// fortress view is reloaded too — unlike a route change, an import genuinely
// does replace what its working copy was built from.
function refreshAfterImport() {
    if (typeof renderRailStanding === "function") renderRailStanding();
    if (typeof refreshKeep === "function") refreshKeep();
    if (typeof refreshCampaign === "function") refreshCampaign();
    if (typeof renderSealPanel === "function") renderSealPanel();

    if (typeof loadCategories === "function" && typeof renderCategoryList === "function") {
        loadCategories().then(({ categories, manualSites: manual }) => {
            categoryState = categories;
            manualSites = manual;
            renderCategoryList();
        });
    }
}

document.addEventListener("DOMContentLoaded", renderBackupPanel);
