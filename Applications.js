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
    const exe = normalizeExecutable(source.exe || source.id);
    if (!exe) return null;

    return {
        id: applicationId(exe),
        exe: exe,
        name: String(source.name || applicationDisplayName(exe))
            .slice(0, MAX_APPLICATION_NAME_LENGTH),
        enabled: source.enabled === true,
        permanent: source.permanent === true
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
            // The later entry's name wins, matching the merge rule, where a
            // name is cosmetic and follows the newer commit.
            held.name = application.name;
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
        .filter((entry) => entry.enabled)
        .map((entry) => entry.exe);
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
        normalizeApplication,
        normalizeApplicationList,
        findApplication,
        blockedExecutables,
        isPermanentApplication
    });
}
