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
    unlockCount: 0,
    // Resistance streak: consecutive Stay Focused choices with no unlock in
    // between. Counted in CHOICES, not days — unlike the discipline streak
    // above, which is a run of calendar days. The two measure different things
    // on purpose: one rewards showing restraint often, the other rewards
    // staying clean over time.
    currentResistance: 0,
    longestResistance: 0,
    // Whether the one-off day-log backfill has run. See ensureDayLogSeeded().
    dayLogSeeded: false,
    // "YYYY-MM-DD" of the earliest day this fortress has any history for.
    // Stamped once, when the backfill runs, rather than derived from the log on
    // every read — a long quiet stretch or retention pruning would otherwise
    // walk it forward and make Dominus claim it wasn't installed yet.
    historyStartedOn: null
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

// Runs the backfill at most once per fortress.
//
// It used to be guarded by the log being empty, which was the wrong test: the
// moment any real day was recorded — one Stay Focused before this page had ever
// been opened — the backfill was skipped forever and an existing streak never
// appeared. The flag lives in `stats` so the decision survives pruning, and the
// whole thing runs as one queued operation so a concurrent write can't land
// between reading the flag and setting it.
function ensureDayLogSeeded() {
    const run = statsQueue.then(async () => {
        const stats = await getStatsRaw();
        if (stats.dayLogSeeded) return stats;

        const log = await getDayLogRaw();
        const seeded = pruneDayLog(seedDayLog(log, stats));
        await setDayLogRaw(seeded);

        // The earliest day there is any evidence for. On a fresh install that
        // is today; on a fortress upgrading with a streak it is the oldest day
        // the backfill just drew in, so those days keep showing.
        const known = Object.keys(seeded).sort();

        stats.dayLogSeeded = true;
        stats.historyStartedOn = known.length ? known[0] : todayLocal();

        await setStatsRaw(stats);
        return stats;
    });

    statsQueue = run.catch(() => {});
    return run;
}

// Where this fortress's history begins. The stored stamp is authoritative; the
// fallback covers a log written by a build that predates the stamp.
function historyStartDate(stats, log) {
    if (stats.historyStartedOn) return stats.historyStartedOn;

    const known = Object.keys(log).sort();
    return known.length ? known[0] : todayLocal();
}

// ---- Public API -----------------------------------------------------------

// Call from the unlock-confirm handler, alongside where tempUnlocks is written.
// Counts the unlock and marks today not-clean. If today had already been counted
// as a clean day, roll that day back out of the streak (multiple unlocks in one
// day still only cost the streak once, since the rollback only fires the first
// time lastCleanDate === today).
//
// `domain` is optional and only feeds the day log, which uses it to name what
// actually gave way. The streak has never cared which site it was.
function recordUnlock(domain) {
    const counters = enqueueStatsUpdate((stats) => {
        const today = todayLocal();

        stats.unlockCount += 1;
        stats.lastUnlockDate = today;

        // An unlock is what a resistance run is a run *against*, so it ends
        // here. longestResistance already holds the high-water mark and is
        // never rolled back.
        stats.currentResistance = 0;

        if (stats.lastCleanDate === today) {
            stats.currentStreak = Math.max(0, stats.currentStreak - 1);
            stats.lastCleanDate =
                stats.currentStreak === 0 ? null : yesterdayOf(today);
        }

        return stats;
    });

    // Queued behind the counters on the same queue, so the two writes for one
    // unlock can never interleave with another event's.
    const log = enqueueDayLogUpdate((log) => touchDay(log, (entry) => {
        entry.unlocks += 1;

        if (domain) {
            entry.sites[domain] = (entry.sites[domain] || 0) + 1;
        }

        // First slip of the day only. "You gave way at 23:14" is the useful
        // fact; the third unlock's timestamp adds nothing.
        if (!entry.firstSlip) {
            entry.firstSlip = localTimeString(new Date());
        }
    }));

    return Promise.all([counters, log]).then(([stats]) => stats);
}

// Call from the "Stay Focused" handler. Feeds the ratio and extends the
// resistance streak. It still must never touch the DAY streak: choosing Stay
// Focused can't manufacture a clean day, and can't reset one either.
function recordStayFocused() {
    const counters = enqueueStatsUpdate((stats) => {
        stats.stayFocusedCount += 1;

        stats.currentResistance += 1;
        stats.longestResistance =
            Math.max(stats.longestResistance, stats.currentResistance);

        return stats;
    });

    // This is what makes a HELD day distinguishable from an untested one: a
    // stand is the only evidence that anything asked something of the user.
    const log = enqueueDayLogUpdate((log) => touchDay(log, (entry) => {
        entry.stands += 1;
    }));

    return Promise.all([counters, log]).then(([stats]) => stats);
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
            currentResistance: stats.currentResistance,
            longestResistance: stats.longestResistance,
            ratio: ratio,
            stayFocusedCount: stats.stayFocusedCount,
            unlockCount: stats.unlockCount
        };
    });
}

// ---- Day log ---------------------------------------------------------------
//
// Everything above is deliberately historyless: two dates and a few counters,
// with the streak DERIVED from them. That is what lets a day you never opened
// the browser count as clean.
//
// A heatmap can't be drawn from that, so 1.10 adds a per-day record alongside
// it. The streak logic above is untouched and remains the source of truth for
// the streak itself — this log is a second, richer view of the same events,
// not a replacement.
//
// Design note — three states, not two:
//
// "Clean vs slipped" throws away the most interesting distinction on the page.
// A day where a blocked site tempted you six times and you walked away every
// time is not the same day as one you spent away from the machine, and the
// streak alone can't tell them apart. So a day is one of:
//
//   untested — you never reached a blocked page. Nothing was asked of you.
//   held     — you reached one, and chose Stay Focused every time.
//   slipped  — you unlocked at least once.
//
// Plus one flag for days that predate this log: `inferred`, meaning "clean,
// but recorded before Dominus kept daily history". Those are shown differently
// rather than claimed as held, because we genuinely don't know whether anything
// tested the user that day.

const DAY_LOG_KEY = "dayLog";

// A little over a year, so a full year can always be shown with some run-up,
// and the object can't grow without bound. Pruned on every write.
const DAY_LOG_RETENTION = 400;

// Not a state a day can be *in* so much as the absence of one: these are days
// that fall before this fortress has any history at all. They are kept distinct
// from "untested" because untested is a positive claim — you were here, nothing
// tested you — and Dominus has no business making that claim about a day before
// it was recording anything. Same reason `inferred` exists.
const DAY_BEFORE = "before";
const DAY_UNTESTED = "untested";
const DAY_HELD = "held";
const DAY_SLIPPED = "slipped";
const DAY_INFERRED = "inferred";

// Shape of one day, keyed "YYYY-MM-DD" local:
//   stands     — Stay Focused choices
//   unlocks    — confirmed unlocks
//   sites      — { domain: unlocks } so a day can name what gave way
//   firstSlip  — "HH:MM" local of the first unlock, or null
//   inferred   — true only for days backfilled from the streak on first run
const DEFAULT_DAY = {
    stands: 0,
    unlocks: 0,
    sites: null,
    firstSlip: null,
    inferred: false
};

function normalizeDayEntry(raw) {
    const source = raw || {};

    return {
        stands: Math.max(0, Math.round(Number(source.stands) || 0)),
        unlocks: Math.max(0, Math.round(Number(source.unlocks) || 0)),
        sites: source.sites && typeof source.sites === "object"
            ? Object.assign({}, source.sites)
            : {},
        firstSlip: source.firstSlip || null,
        inferred: source.inferred === true
    };
}

// "HH:MM" local. Deliberately minute-resolution: the point is "late at night",
// not forensics.
function localTimeString(date) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

// Which of the three states a day is in. A missing entry is untested, which is
// also what a day looks like before anything happens on it.
function dayState(entry) {
    if (!entry) return DAY_UNTESTED;
    if (entry.inferred) return DAY_INFERRED;
    if (entry.unlocks > 0) return DAY_SLIPPED;
    if (entry.stands > 0) return DAY_HELD;
    return DAY_UNTESTED;
}

// ---- Day log storage ------------------------------------------------------
//
// Kept under its own key rather than inside `stats`, because `stats` is
// rewritten on every read (getStats refreshes the streak) and a year of days
// riding along on each of those writes would be waste.

function getDayLogRaw() {
    return new Promise((resolve) => {
        chrome.storage.local.get([DAY_LOG_KEY], (result) => {
            resolve(result[DAY_LOG_KEY] || {});
        });
    });
}

function setDayLogRaw(log) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [DAY_LOG_KEY]: log }, () => resolve(log));
    });
}

// Shares statsQueue with enqueueStatsUpdate, so an unlock's two writes — the
// counters and the day's record — can't interleave with anything else.
function enqueueDayLogUpdate(mutator) {
    const run = statsQueue.then(async () => {
        const log = await getDayLogRaw();
        const updated = await mutator(log);
        await setDayLogRaw(updated);
        return updated;
    });
    statsQueue = run.catch(() => {});
    return run;
}

// Drops anything past the retention window. String comparison works because
// the keys are "YYYY-MM-DD".
function pruneDayLog(log) {
    const cutoff = addDaysLocal(todayLocal(), -DAY_LOG_RETENTION);
    const kept = {};

    Object.keys(log).forEach((date) => {
        if (date >= cutoff) kept[date] = log[date];
    });

    return kept;
}

// Reads (and creates) today's record.
function touchDay(log, mutate) {
    const today = todayLocal();
    const entry = normalizeDayEntry(log[today]);

    // A day that gets a real event is no longer inferred, whatever the backfill
    // put there.
    entry.inferred = false;
    mutate(entry);

    log[today] = entry;
    return pruneDayLog(log);
}

// ---- Backfill -------------------------------------------------------------

// Gives the grid something to show on the day this ships, instead of a wall of
// empty squares that reads as a year of failure.
//
// The current streak is, by definition, that many consecutive days with no
// unlock ending at lastCleanDate — so those days can be stated with confidence.
// What can't be stated is whether anything tested the user on them, which is
// exactly why they are marked `inferred` and drawn differently rather than
// being claimed as held.
//
// Never overwrites a day that already has a real record — the backfill only
// fills gaps.
function seedDayLog(log, stats) {
    if (!stats.lastCleanDate || stats.currentStreak < 1) return log;

    const today = todayLocal();
    let date = stats.lastCleanDate;

    for (let i = 0; i < stats.currentStreak; i++) {
        // Never today. getDayHistory() refreshes the streak before seeding, and
        // on a brand-new install that makes today the first clean day ever — so
        // without this guard a fresh fortress opens the page and finds today
        // already stamped "clean, before daily history began", which is exactly
        // backwards: today is the first day there IS a record for.
        if (date !== today && log[date] === undefined) {
            log[date] = {
                stands: 0,
                unlocks: 0,
                sites: {},
                firstSlip: null,
                inferred: true
            };
        }

        date = yesterdayOf(date);
    }

    return log;
}

// Runs the backfill at most once per fortress.
//
// It used to be guarded by the log being empty, which was the wrong test: the
// moment any real day was recorded — one Stay Focused before this page had ever
// been opened — the backfill was skipped forever and an existing streak never
// appeared. The flag lives in `stats` so the decision survives pruning, and the
// whole thing runs as one queued operation so a concurrent write can't land
// between reading the flag and setting it.
function ensureDayLogSeeded() {
    const run = statsQueue.then(async () => {
        const stats = await getStatsRaw();
        if (stats.dayLogSeeded) return stats;

        const log = await getDayLogRaw();
        const seeded = pruneDayLog(seedDayLog(log, stats));
        await setDayLogRaw(seeded);

        // The earliest day there is any evidence for. On a fresh install that
        // is today; on a fortress upgrading with a streak it is the oldest day
        // the backfill just drew in, so those days keep showing.
        const known = Object.keys(seeded).sort();

        stats.dayLogSeeded = true;
        stats.historyStartedOn = known.length ? known[0] : todayLocal();

        await setStatsRaw(stats);
        return stats;
    });

    statsQueue = run.catch(() => {});
    return run;
}

// Where this fortress's history begins. The stored stamp is authoritative; the
// fallback covers a log written by a build that predates the stamp.
function historyStartDate(stats, log) {
    if (stats.historyStartedOn) return stats.historyStartedOn;

    const known = Object.keys(log).sort();
    return known.length ? known[0] : todayLocal();
}

// ---- Public API -----------------------------------------------------------

// `days` calendar days ending today, oldest first, every day present whether or
// not anything was recorded on it — the caller draws a grid and needs the gaps.
function getDayHistory(days) {
    // Order matters: the streak is brought current first, because the backfill
    // reads lastCleanDate and currentStreak off it.
    return enqueueStatsUpdate((stats) => {
        updateStreak(stats, todayLocal());
        return stats;
    }).then(
        () => ensureDayLogSeeded()
    ).then((stats) => enqueueDayLogUpdate(pruneDayLog).then((log) => {
        const start = historyStartDate(stats, log);
        const history = [];
        let date = addDaysLocal(todayLocal(), -(days - 1));

        for (let i = 0; i < days; i++) {
            // String comparison works on "YYYY-MM-DD". Today can never fall
            // here: the start date is at worst today itself.
            const before = date < start;
            const entry = (!before && log[date]) ? normalizeDayEntry(log[date]) : null;

            history.push({
                date: date,
                state: before ? DAY_BEFORE : dayState(entry),
                entry: entry
            });

            date = addDaysLocal(date, 1);
        }

        return history;
    }));
}
