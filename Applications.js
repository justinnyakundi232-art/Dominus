// Applications.js — the programs in your fortress.
//
// The shape, the identity rule and the reasoning are in
// desktop/APP-LIMITS.md. This is the storage and normalisation half, and it
// lives at the repository root rather than in desktop/ for the same reason
// Sync.js does: the extension is the record holder and the merge authority for
// applications even though it can never enforce one, so both surfaces need
// exactly these functions and neither is allowed its own copy.
//
// Dependency-free classic script. Everything is declared at the top level and
// nothing runs at load, which is what lets the service worker pull it in with
// importScripts() and lets Tests/load.js concatenate it into one context.
//
// Note the division: nothing here decides whether an application is blocked
// *right now*. That needs the temporary unlocks and the clock, and it happens
// where the enforcement happens. This file only says what an application is.

const APPLICATIONS_KEY = "applications";

// The same ceiling a category name gets. It is a label in a list, not a place
// to keep a note.
const MAX_APPLICATION_NAME_LENGTH = 40;

// A day's allowance, in whole minutes. 0 means blocked outright — which is also
// what every entry written before allowances existed means, so a missing field
// changes nothing about a fortress that already has programs in it. A whole day
// is the ceiling: an allowance above it could never run out and would only be a
// block pretending to be one. See "Daily allowances" in APP-LIMITS.md.
const MAX_ALLOWANCE_MINUTES = 24 * 60;

// How long before the allowance runs out the reminder appears. 0 is no
// reminder. An hour is plenty of notice for anything a reminder is for.
const DEFAULT_WARN_MINUTES = 5;
const MAX_WARN_MINUTES = 60;

function clampWholeMinutes(raw, max, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(max, Math.round(n)));
}

// Programs Dominus will never stand in front of, whoever asks.
//
// Not a preference list — a floor. Each of these is here because blocking it
// would do something other than block it:
//
//   explorer.exe            the Windows shell. It owns the taskbar and the
//                           desktop, so clicking either makes it the
//                           foreground, and the gate would minimize the
//                           thing you use to get anywhere.
//   dominus.exe             the gate itself is a dominus.exe window.
//   taskmgr.exe             the way out of anything. Dominus is a tool, not a
//                           cage, and a fortress that can block the exit is a
//                           cage.
//   systemsettings.exe      where a program is uninstalled. If you truly do
//                           not want something, that is the honest fix, and
//                           Dominus must never stand between you and it.
//   applicationframehost.exe  the host every Store app runs inside. Blocking it
//                           would block all of them at once under one name.
//   the rest                parts of Windows that briefly take the foreground
//                           (Start, search, the lock screen, notifications).
//
// Enforced where an application ENTERS the fortress — normalizeApplication()
// refuses these — so a list arriving from a peer, a backup or a hand-edited
// file cannot carry one in either.
const PROTECTED_EXECUTABLES = [
    "explorer.exe",
    "dominus.exe",
    "taskmgr.exe",
    "systemsettings.exe",
    "applicationframehost.exe",
    "dwm.exe",
    "csrss.exe",
    "winlogon.exe",
    "lockapp.exe",
    "logonui.exe",
    "searchhost.exe",
    "searchapp.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "textinputhost.exe",
    "sihost.exe"
];

function isProtectedExecutable(exe) {
    return PROTECTED_EXECUTABLES.includes(normalizeExecutable(exe));
}

// ---- Identity -------------------------------------------------------------

// An executable's basename, lowercased.
//
// This is the whole identity of an application in Dominus, and the choice is
// argued in APP-LIMITS.md. The short version: the full path differs between
// machines, between drives and after a reinstall, and Phase 5 puts this
// fortress on a second computer. The basename is the part that is stable.
//
// Accepts a full path, a bare name, or either separator, because it is fed by
// three different things — a Windows process image path, a picker in the app,
// and whatever a peer sends over the wire.
function normalizeExecutable(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";

    // Both separators, always. A path from the wire may have been written on a
    // different platform than the one reading it.
    const parts = text.split(/[\\/]+/);
    const name = parts[parts.length - 1].trim().toLowerCase();

    // A path ending in a separator has no basename, and "." and ".." are not
    // programs. Left empty so the caller's own guard rejects them.
    if (!name || name === "." || name === "..") return "";
    return name;
}

// The id is derived from the executable, never generated.
//
// This is the load-bearing decision in the whole file. Two devices that each
// blocked Steam, separately, with no chance to coordinate, must agree that they
// blocked the same thing — otherwise the union in mergeApplications() keeps
// both and hands the user two Steams, forever, with no way to tell them apart.
//
// A random id cannot do that. A derived one cannot fail to.
function applicationId(exe) {
    const name = normalizeExecutable(exe);
    return name ? "app:" + name : "";
}

// "steam.exe" -> "Steam". A first guess at a label, used when something is
// added from a process list that had no friendlier name to offer. The user can
// rename it afterwards; this only has to be better than showing them "steam.exe".
function applicationDisplayName(exe) {
    const name = normalizeExecutable(exe);
    if (!name) return "";

    const stem = name.replace(/\.(exe|app|com|bat|cmd)$/i, "");
    if (!stem) return name;

    // Separators become spaces, then each word gets its capital. "vs_code" and
    // "vs-code" both read as "Vs Code", which is wrong but recognisable, and
    // recognisable is the entire job of a default.
    return stem
        .split(/[\s._-]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

// ---- Normalising ----------------------------------------------------------

// One application, made safe.
//
// Returns null rather than a repaired object when there is no usable
// executable, because an application without one is not a weakened entry — it
// is not an entry. It would match no process and could never be unblocked,
// which is worse than not being there.
function normalizeApplication(raw) {
    const source = raw || {};
    // An id is "app:" + exe. Strip the prefix rather than trusting whoever sent
    // it to have sent the exe as well.
    const exe = normalizeExecutable(source.exe || String(source.id || "").replace(/^app:/, ""));
    if (!exe) return null;

    // Refused rather than repaired, for the reason on PROTECTED_EXECUTABLES.
    if (isProtectedExecutable(exe)) return null;

    return {
        id: applicationId(exe),
        exe: exe,
        name: String(source.name || applicationDisplayName(exe))
            .slice(0, MAX_APPLICATION_NAME_LENGTH),
        enabled: source.enabled === true,
        permanent: source.permanent === true,
        // Anything unreadable reads as 0 — blocked outright — because the safe
        // wrong answer about a defence is the stronger one.
        allowanceMinutes: clampWholeMinutes(source.allowanceMinutes, MAX_ALLOWANCE_MINUTES, 0),
        warnMinutes: clampWholeMinutes(source.warnMinutes, MAX_WARN_MINUTES, DEFAULT_WARN_MINUTES)
    };
}

// A list, deduplicated by id.
//
// Duplicates are not hypothetical: a user can add Steam from the picker on one
// device and by hand on another, and both entries arrive in the same union. The
// survivor is the stronger of the two on every flag, because dropping one of
// them silently is the one outcome that could take a defence down here.
//
// Permanence cannot outlive being switched off, the same rule
// normalizeCategoryList() enforces and for the same reason: a stale flag on a
// disabled entry would re-apply the moment it was ticked again.
function normalizeApplicationList(raw) {
    if (!Array.isArray(raw)) return [];

    const byId = new Map();

    raw.forEach((entry) => {
        const application = normalizeApplication(entry);
        if (!application) return;

        const held = byId.get(application.id);
        if (held) {
            held.enabled = held.enabled || application.enabled;
            held.permanent = held.permanent || application.permanent;
            // The smaller allowance is the stronger one, and 0 — blocked — is
            // the smallest of all.
            held.allowanceMinutes = Math.min(held.allowanceMinutes, application.allowanceMinutes);
            // The later entry's name and warning win, matching the merge rule:
            // neither defends anything, so neither has a stronger direction.
            held.name = application.name;
            held.warnMinutes = application.warnMinutes;
        } else {
            byId.set(application.id, application);
        }
    });

    const out = [...byId.values()];
    out.forEach((application) => {
        if (!application.enabled) application.permanent = false;
    });

    return out;
}

// ---- Reading -------------------------------------------------------------

function findApplication(applications, exe) {
    const id = applicationId(exe);
    if (!id) return null;
    return (applications || []).find((entry) => entry.id === id) || null;
}

// The executables the fortress currently stands against: enabled entries only.
//
// This is what gets handed to the enforcement side, and it is deliberately a
// plain array of strings rather than the entries themselves. The thing doing
// the enforcing has no business knowing an application's name, whether it is
// permanent, or anything else it might be tempted to make a decision with.
function blockedExecutables(applications) {
    return normalizeApplicationList(applications)
        .filter((entry) => entry.enabled && entry.allowanceMinutes === 0)
        .map((entry) => entry.exe);
}

// The programs that are allowed some time a day, keyed by executable, in the
// units the watcher counts in. Enabled entries only, and never a blocked one —
// those are in blockedExecutables() instead, so no program is in both.
function allowancesFor(applications) {
    const out = {};
    normalizeApplicationList(applications)
        .filter((entry) => entry.enabled && entry.allowanceMinutes > 0)
        .forEach((entry) => {
            out[entry.exe] = {
                allowance_secs: entry.allowanceMinutes * 60,
                // Never at or past the allowance itself: a warning that arrives
                // with the gate is not a warning.
                warn_secs: Math.min(entry.warnMinutes, entry.allowanceMinutes - 1) * 60
            };
        });
    return out;
}

// Everything the desktop watcher is told, from a synced state, for `today`.
//
// One function, because two windows send it — the main window on every change,
// the gate after an unlock — and a second hand-built copy is how the gate once
// stood to wipe every allowance by sending the old shape. Names and fields
// match `watcher::Enforced` in the desktop app.
//
// Needs deriveUsage() from Sync.js at call time, which every window that calls
// this has loaded.
function enforcementFor(state, today) {
    const fortress = (state && state.fortress) || {};
    const unlocks = (state && state.tempUnlocks) || {};
    const now = Date.now();

    const blocked = blockedExecutables(fortress.applications);
    const allowances = allowancesFor(fortress.applications);

    const until = {};
    blocked.concat(Object.keys(allowances)).forEach((exe) => {
        const expiry = Number(unlocks[exe]) || 0;
        if (expiry > now) until[exe] = expiry;
    });

    const used = deriveUsage((state && state.events) || [], today);
    const spent = {};
    Object.keys(allowances).forEach((exe) => { spent[exe] = used[exe] || 0; });

    return {
        blocked: blocked,
        unlocked_until: until,
        allowances: allowances,
        spent: spent,
        day: today
    };
}

// "45 min", "1 h", "1 h 30 min". Whole minutes are all an allowance is set in.
function formatAllowance(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    const h = Math.floor(m / 60);
    const rest = m % 60;
    if (!h) return rest + " min";
    return rest ? h + " h " + rest + " min" : h + " h";
}

function isPermanentApplication(applications, exe) {
    const application = findApplication(applications, exe);
    return Boolean(application && application.enabled && application.permanent);
}

// ---- Storage --------------------------------------------------------------

function loadApplications() {
    return new Promise((resolve) => {
        chrome.storage.local.get([APPLICATIONS_KEY], (result) => {
            resolve(normalizeApplicationList(result[APPLICATIONS_KEY]));
        });
    });
}

// Never called by the extension's own UI, which has no way to offer a process
// list and therefore no way to add one. It exists for applyMerge(), which
// writes what arrived from the app, and for Backup.js restoring a file.
function saveApplications(applications) {
    const list = normalizeApplicationList(applications);
    return new Promise((resolve) => {
        chrome.storage.local.set({ [APPLICATIONS_KEY]: list }, () => resolve(list));
    });
}

// Node's test loader reads this; the browser and the service worker ignore it.
if (typeof module !== "undefined" && module.exports) {
    // Additive, not a replacement — see the same note in Sync.js.
    Object.assign(module.exports, {
        normalizeExecutable,
        applicationId,
        applicationDisplayName,
        isProtectedExecutable,
        normalizeApplication,
        normalizeApplicationList,
        findApplication,
        blockedExecutables,
        allowancesFor,
        enforcementFor,
        formatAllowance,
        isPermanentApplication
    });
}
