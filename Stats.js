// Stats.js — shared stats data layer for Dominus.
//
// Tracks two things, both stored under a single `stats` object in
// chrome.storage.local:
//   1. A clean-day streak (consecutive local calendar days with no unlock).
//   2. A Stay Focused vs. Unlock ratio.
//
// Dependency-free classic script: every function below is declared at the top
// level so it is available on the global scope. Load it via <script src="Stats.js">
// before any page script that calls it (e.g. Blocked.js), or via
// importScripts("Stats.js") from a service worker — both contexts share
// chrome.storage.local, so the same functions work in either.
//
// Design note — "absence of unlocks = clean":
// The streak is DERIVED from dates, not from a running per-day toggle, because
// the extension is not guaranteed to run every day. We only persist the most
// recent clean date and the most recent unlock date. A day is considered clean
// unless an unlock was recorded during it, so a user who simply didn't browse
// (no unlocks) keeps their streak. The streak only resets when a recorded
// unlock date falls after the last counted clean day.

// ---- Schema ---------------------------------------------------------------

// Shape of the `stats` object. On first run it won't exist in storage; a
// missing object is treated as all-zero / null and initialized on first write.
const DEFAULT_STATS = {
    currentStreak: 0,
    longestStreak: 0,
    lastCleanDate: null,   // "YYYY-MM-DD" local, or null if never set
    lastUnlockDate: null,  // "YYYY-MM-DD" local, set when an unlock is confirmed
    stayFocusedCount: 0,
    unlockCount: 0
};

// Merge whatever is in storage over the defaults so a partial/missing object
// is always normalized to the full schema.
function normalizeStats(raw) {
    return Object.assign({}, DEFAULT_STATS, raw || {});
}

// ---- Local-date helpers (never mix UTC and local) -------------------------

// "YYYY-MM-DD" for a Date in the user's LOCAL timezone.
function localDateString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

// Today's local date as "YYYY-MM-DD".
function todayLocal() {
    return localDateString(new Date());
}

// Shift a local "YYYY-MM-DD" by `delta` days and return the new local date.
// Built from local midnight so DST shifts don't move us across a day boundary.
function addDaysLocal(dateStr, delta) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    return localDateString(dt);
}

function yesterdayOf(dateStr) {
    return addDaysLocal(dateStr, -1);
}

// Whole days between two local date strings (end - start). Math.round absorbs
// the ±1h wobble a DST change can introduce between two local midnights.
function daysBetween(startStr, endStr) {
    const [y1, m1, d1] = startStr.split("-").map(Number);
    const [y2, m2, d2] = endStr.split("-").map(Number);
    const start = new Date(y1, m1 - 1, d1);
    const end = new Date(y2, m2 - 1, d2);
    return Math.round((end - start) / 86400000);
}

// ---- Storage access + serialized read-modify-write ------------------------

function getStatsRaw() {
    return new Promise((resolve) => {
        chrome.storage.local.get(["stats"], (result) => {
            resolve(normalizeStats(result.stats));
        });
    });
}

function setStatsRaw(stats) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ stats: stats }, () => resolve(stats));
    });
}

// All mutations funnel through this single serialized queue so two quick events
// (e.g. a Stay Focused click and an unlock landing back-to-back) each read the
// latest value and can't clobber each other's write.
let statsQueue = Promise.resolve();

// Runs `mutator(stats)` against the freshest stored stats, then persists the
// result. `mutator` receives the full normalized object, mutates/returns it,
// and may be sync or async. Returns a promise resolving to the updated stats.
function enqueueStatsUpdate(mutator) {
    const run = statsQueue.then(async () => {
        const stats = await getStatsRaw();
        const updated = await mutator(stats);
        await setStatsRaw(updated);
        return updated;
    });
    // Keep the queue alive even if this operation rejected, so later updates
    // still run; callers of `run` still see the rejection.
    statsQueue = run.catch(() => {});
    return run;
}

// ---- Streak logic (derived from dates, not a running toggle) --------------

// Brings the streak current as of `today`, mutating `stats` in place.
// Assumes `today` has had no unlock yet unless one is already recorded for it.
function updateStreak(stats, today) {
    today = today || todayLocal();

    // If today was already marked dirty by an unlock, today is not clean:
    // don't advance the streak, leave the prior run intact.
    if (stats.lastUnlockDate === today && stats.lastCleanDate !== today) {
        return stats;
    }

    const lastClean = stats.lastCleanDate;

    // First clean day ever.
    if (lastClean === null) {
        stats.currentStreak = 1;
        stats.lastCleanDate = today;
        stats.longestStreak = Math.max(stats.longestStreak, stats.currentStreak);
        return stats;
    }

    // Already counted today.
    if (lastClean === today) {
        return stats;
    }

    const gap = daysBetween(lastClean, today); // >= 1

    // A break happened only if an unlock was recorded strictly after the last
    // counted clean day (i.e. some day in the gap was dirty). We keep only the
    // most recent unlock date, which is sufficient because the streak is a
    // consecutive run updated incrementally. String compare works on YYYY-MM-DD.
    const unlockAfterLastClean =
        stats.lastUnlockDate !== null && stats.lastUnlockDate > lastClean;

    if (unlockAfterLastClean) {
        // A dirty day occurred since the last clean day -> streak resets, and
        // today (guarded clean above) becomes the fresh start.
        stats.currentStreak = 1;
    } else {
        // No unlocks since the last clean day: every elapsed day, including any
        // skipped no-browsing days, counts as clean (absence of unlocks = clean).
        stats.currentStreak += gap;
    }

    stats.lastCleanDate = today;
    stats.longestStreak = Math.max(stats.longestStreak, stats.currentStreak);
    return stats;
}

// ---- Public API -----------------------------------------------------------

// Call from the unlock-confirm handler, alongside where tempUnlocks is written.
// Counts the unlock and marks today not-clean. If today had already been counted
// as a clean day, roll that day back out of the streak (multiple unlocks in one
// day still only cost the streak once, since the rollback only fires the first
// time lastCleanDate === today).
function recordUnlock() {
    return enqueueStatsUpdate((stats) => {
        const today = todayLocal();

        stats.unlockCount += 1;
        stats.lastUnlockDate = today;

        if (stats.lastCleanDate === today) {
            stats.currentStreak = Math.max(0, stats.currentStreak - 1);
            stats.lastCleanDate =
                stats.currentStreak === 0 ? null : yesterdayOf(today);
        }

        return stats;
    });
}

// Call from the "Stay Focused" handler. Feeds the ratio only — Stay Focused
// clicks never keep a streak alive and must never reset it.
function recordStayFocused() {
    return enqueueStatsUpdate((stats) => {
        stats.stayFocusedCount += 1;
        return stats;
    });
}

// Read-side accessor for a future progress page. Refreshes the streak (so
// elapsed clean days are reflected) and returns a compact view. `ratio` is
// stayFocused / (stayFocused + unlock), or null when there's no data yet.
function getStats() {
    return enqueueStatsUpdate((stats) => {
        updateStreak(stats, todayLocal());
        return stats;
    }).then((stats) => {
        const total = stats.stayFocusedCount + stats.unlockCount;
        const ratio = total === 0 ? null : stats.stayFocusedCount / total;
        return {
            currentStreak: stats.currentStreak,
            longestStreak: stats.longestStreak,
            ratio: ratio,
            stayFocusedCount: stats.stayFocusedCount,
            unlockCount: stats.unlockCount
        };
    });
}
