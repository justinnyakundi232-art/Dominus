// Sync.js — device identity, the event log, and the merge rules.
//
// Dominus is becoming two programs: the extension, which keeps the gate, and
// the desktop app, which holds the keep. This file is what lets them agree
// about one fortress without either of them being in charge.
//
// Dependency-free classic script, same contract as Tasks.js, Categories.js and
// Seal.js: every function is declared at the top level, nothing touches storage
// or the DOM at load time, and it is safe to include from any page in any
// order. It reads helpers from Stats.js (todayLocal, addDaysLocal,
// normalizeDayEntry), Tasks.js (normalizeCooldown) and Categories.js
// (normalizeCategoryList) inside functions, so those must be loaded alongside
// it — but not necessarily first. It is also safe under importScripts() in the
// service worker, which is where the periodic sync runs from.
//
// NOTHING HERE SENDS ANYTHING ANYWHERE YET. The transport is deliberately a
// no-op (see syncNow at the bottom). What ships now is the record-keeping and
// the merge rules, so that by the time there is a peer to talk to there is a
// real history to talk about — and so the rules can be argued with and tested
// while getting them wrong is still free.
//
// ---------------------------------------------------------------------------
// Design note — why not just sync chrome.storage.local
//
// Because the keys do not all mean the same kind of thing. `stayFocusedCount`
// is additive: two devices each recording one stand means two stands, and
// last-writer-wins gives you one, quietly and forever. `blockedSites` is a
// derived cache: syncing it lets what is enforced drift from what is shown,
// which is the exact failure writeFortress() exists to prevent. `sealAttempts`
// is a penalty: overwriting it with a device that hasn't seen the failures
// clears an escalating wait the user already earned.
//
// So the data splits in two, and the two halves merge by completely different
// rules:
//
//   Channel A — the event log. Append-only, one record per stand and per
//   unlock, each with a stable id. Merging is a set union by id, which cannot
//   conflict. The day log and the resistance streak are RECOMPUTED from the
//   union rather than merged.
//
//   Channel B — the fortress. Categories, manual sites, the task, the cooldown,
//   the seal. Merging is strengthen-wins: a merge can raise a defence but never
//   lower one. Lowering happens only when a peer sends an *authored* record
//   saying the user deliberately took it down — a list of them, kept and
//   replayed rather than consumed. See the note above mergeAuthored().
//
// Channel A falls straight out of a decision already made in Stats.js: the
// streak is derived from dates rather than stored as a running toggle. That was
// done so a day away from the machine still counts as clean. It happens to also
// be what makes the streak mergeable.
//
// Channel B is the seal rule — strengthening the fortress is free, weakening it
// costs the seal — applied to conflict resolution. It means the worst case of a
// confused merge is that you have to take a defence down again on purpose, not
// that one quietly stopped being enforced while you weren't looking.

// ---- Storage keys ---------------------------------------------------------

// This device's identity. Created once, on first use, and never synced — it is
// what makes every other record attributable.
const SYNC_DEVICE_KEY = "syncDevice";

// The append-only event log. See the note above.
const SYNC_EVENTS_KEY = "syncEvents";

// Revision stamps, per-device all-time counters, and the last authored
// weakening. Everything the merge needs that isn't an event or a fortress key.
const SYNC_META_KEY = "syncMeta";

// ---- Retention ------------------------------------------------------------

// Matches DAY_LOG_RETENTION in Stats.js exactly, and must keep matching: the
// day log is recomputed from these events, so an event log that ran shorter
// than the day log would make history vanish on the next merge.
//
// Both peers prune by the same date rule, so both drop the same events and the
// union stays the same on both sides. That determinism is the whole reason to
// prune by date rather than by count — dropping the oldest N events would drop
// a different N on each device and lose records that only one of them held.
const EVENT_RETENTION_DAYS = 400;

// ---- Event types ----------------------------------------------------------

const EVENT_STAND = "stand";
const EVENT_UNLOCK = "unlock";
const EVENT_COMMIT = "commit";

// ---- Device identity ------------------------------------------------------

function normalizeDevice(raw) {
    const source = raw || {};
    if (!source.id) return null;

    return {
        id: String(source.id),
        surface: source.surface === "desktop" ? "desktop" : "extension",
        createdAt: Math.max(0, Number(source.createdAt) || 0)
    };
}

// Resolves this device's identity, creating it on first call.
//
// Serialized through the same queue as everything else here so two pages
// opening at once can't each mint an id and have one of them win — a device
// that changes its id looks like a brand new peer, and its per-device counters
// would be counted twice.
let syncQueue = Promise.resolve();

function enqueueSync(work) {
    const run = syncQueue.then(work);
    syncQueue = run.catch(() => {});
    return run;
}

function loadDeviceRaw() {
    return new Promise((resolve) => {
        chrome.storage.local.get([SYNC_DEVICE_KEY], (result) => {
            resolve(normalizeDevice(result[SYNC_DEVICE_KEY]));
        });
    });
}

function ensureDevice() {
    return enqueueSync(async () => {
        const existing = await loadDeviceRaw();
        if (existing) return existing;

        const device = {
            id: crypto.randomUUID(),
            surface: "extension",
            createdAt: Date.now()
        };

        await new Promise((resolve) => {
            chrome.storage.local.set({ [SYNC_DEVICE_KEY]: device }, resolve);
        });

        return device;
    });
}

// ---- Sync metadata --------------------------------------------------------

// `counters` is a grow-only counter per device: each device only ever raises
// its own entry, merging takes the max per device, and the displayed total is
// the sum across all of them. This is what makes the all-time stand and unlock
// totals survive both merging AND event pruning — the event log only reaches
// back EVENT_RETENTION_DAYS, but these totals are all-time and must not shrink
// when old events are dropped.
//
// `fortressRev` is a monotonic revision for Channel B, raised on every commit.
// It settles the handful of fortress fields where neither side is stricter than
// the other (a category's name, or two different unlock tasks), and it is what
// an authored weakening is compared against.
//
// `authored` is the list of deliberate weakenings this fortress has committed,
// on any device — the only thing that can take a defence down on a peer. It is
// appended to and adopted from peers rather than replaced and consumed; the
// four rules that govern it are argued above mergeAuthored().
function normalizeSyncMeta(raw) {
    const source = raw || {};
    const counters = {};

    const rawCounters = source.counters && typeof source.counters === "object"
        ? source.counters
        : {};

    Object.keys(rawCounters).forEach((deviceId) => {
        const entry = rawCounters[deviceId] || {};
        counters[deviceId] = {
            stands: Math.max(0, Math.round(Number(entry.stands) || 0)),
            unlocks: Math.max(0, Math.round(Number(entry.unlocks) || 0))
        };
    });

    return {
        fortressRev: Math.max(0, Math.round(Number(source.fortressRev) || 0)),
        counters: counters,
        authored: normalizeAuthoredList(source.authored),
        lastSyncedAt: Math.max(0, Number(source.lastSyncedAt) || 0),
        // Whether this device's counter has absorbed the history that predates
        // counters existing at all. See ensureCountersSeeded().
        countersSeeded: source.countersSeeded === true
    };
}

// Folds everything this fortress recorded before 1.11 into this device's
// counter, once.
//
// The counters are meant to be the all-time totals — grow-only per device,
// summed across them, immune to the event log being pruned. But they were
// added in 1.11, and a fortress that has been running for months already has
// its whole history in stats.stayFocusedCount and stats.unlockCount. Without
// this, `counters` means "since you upgraded" while `stats` means "ever", and
// anything reading the counters reports a fraction of the truth — which is
// exactly what the desktop app did on first sync: 100% of five moments, beside
// the extension's 86% of two hundred and fifty-six.
//
// stats is this browser's own all-time record and already includes anything
// counted since the upgrade, so this assigns rather than adds. Guarded by a
// flag, so it is safe to call on every path that touches the counters.
function ensureCountersSeeded() {
    return enqueueSync(async () => {
        const meta = await getSyncMetaRaw();
        if (meta.countersSeeded) return meta;

        const device = await loadDeviceRaw();
        if (!device) return meta;

        const stats = await getStatsRaw();

        // The higher of the two, not simply the stats figure. In practice
        // stats is always the larger — every event increments both — so this
        // is the same answer by a safer route. It matters for the case where
        // it isn't: a counter restored from a backup can hold a total this
        // browser's own stats never saw, and assigning would throw it away.
        const held = meta.counters[device.id] || { stands: 0, unlocks: 0 };

        meta.counters[device.id] = {
            stands: Math.max(held.stands, Math.max(0, Math.round(Number(stats.stayFocusedCount) || 0))),
            unlocks: Math.max(held.unlocks, Math.max(0, Math.round(Number(stats.unlockCount) || 0)))
        };
        meta.countersSeeded = true;

        await setSyncMetaRaw(meta);
        return meta;
    });
}

function getSyncMetaRaw() {
    return new Promise((resolve) => {
        chrome.storage.local.get([SYNC_META_KEY], (result) => {
            resolve(normalizeSyncMeta(result[SYNC_META_KEY]));
        });
    });
}

function setSyncMetaRaw(meta) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [SYNC_META_KEY]: meta }, () => resolve(meta));
    });
}

function enqueueSyncMetaUpdate(mutator) {
    return enqueueSync(async () => {
        const meta = await getSyncMetaRaw();
        const updated = await mutator(meta);
        await setSyncMetaRaw(updated);
        return updated;
    });
}

// ---- The event log --------------------------------------------------------

function normalizeEvent(raw) {
    const source = raw || {};
    if (!source.id || !source.type) return null;

    const event = {
        id: String(source.id),
        type: String(source.type),
        device: String(source.device || ""),
        // Milliseconds since epoch. Used for ordering across devices.
        at: Math.max(0, Number(source.at) || 0),
        // The LOCAL date of the device that recorded it, not derived from `at`.
        //
        // This matters and is not redundant. Everything in Stats.js is
        // local-date based on purpose, so an unlock at 1am belongs to the day it
        // felt like rather than to whatever UTC thought. Deriving the date from
        // `at` on a second device in another timezone would move that unlock to
        // a different square in the history grid.
        date: String(source.date || "")
    };

    if (source.domain) event.domain = String(source.domain);
    // Local "HH:MM" of the recording device, for dayLog.firstSlip.
    if (source.time) event.time = String(source.time);
    if (source.rev !== undefined) event.rev = Math.max(0, Math.round(Number(source.rev) || 0));

    return event.date ? event : null;
}

function normalizeEventLog(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeEvent).filter(Boolean);
}

function getEventLogRaw() {
    return new Promise((resolve) => {
        chrome.storage.local.get([SYNC_EVENTS_KEY], (result) => {
            resolve(normalizeEventLog(result[SYNC_EVENTS_KEY]));
        });
    });
}

function setEventLogRaw(events) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [SYNC_EVENTS_KEY]: events }, () => resolve(events));
    });
}

// Drops anything past the retention window. String comparison works because the
// dates are "YYYY-MM-DD", the same trick pruneDayLog() uses.
function pruneEvents(events, today) {
    const cutoff = addDaysLocal(today || todayLocal(), -EVENT_RETENTION_DAYS);
    return events.filter((event) => event.date >= cutoff);
}

// Appends one event and raises this device's own counter for it.
//
// Both writes happen under the same queued operation, because the counter is
// what survives the event being pruned in a year's time — an event recorded
// without its counter raised would silently un-count itself on that day.
function recordSyncEvent(type, payload, now) {
    // The clock is read once, by the caller where it needs the time for other
    // reasons, so an event recorded across a minute boundary can't end up with
    // a timestamp and an "HH:MM" that disagree.
    const stamp = now || new Date();

    // Before the increment, never after: seeding assigns this device's counter
    // from stats, so an event counted first would be overwritten by it.
    return ensureDevice()
        .then(() => ensureCountersSeeded())
        .then(() => loadDeviceRaw())
        .then((device) => enqueueSync(async () => {
        const event = normalizeEvent(Object.assign({
            id: crypto.randomUUID(),
            type: type,
            device: device.id,
            at: stamp.getTime(),
            date: localDateString(stamp)
        }, payload || {}));

        if (!event) return null;

        const events = await getEventLogRaw();
        events.push(event);
        await setEventLogRaw(pruneEvents(events, event.date));

        if (type === EVENT_STAND || type === EVENT_UNLOCK) {
            const meta = await getSyncMetaRaw();
            const entry = meta.counters[device.id] || { stands: 0, unlocks: 0 };

            if (type === EVENT_STAND) entry.stands += 1;
            else entry.unlocks += 1;

            meta.counters[device.id] = entry;
            await setSyncMetaRaw(meta);
        }

        return event;
    }));
}

// The three call sites, named rather than left as string literals so a typo in
// an event type is a missing function rather than a silently ignored record.

function recordSyncStand() {
    return recordSyncEvent(EVENT_STAND, {});
}

function recordSyncUnlock(domain) {
    const now = new Date();
    return recordSyncEvent(EVENT_UNLOCK, {
        domain: domain || undefined,
        time: localTimeString(now)
    }, now);
}

function recordSyncCommit(rev) {
    return recordSyncEvent(EVENT_COMMIT, { rev: rev });
}

// ---- Deriving from events -------------------------------------------------
//
// Pure: no storage, no chrome, no Date.now(). Everything below this point that
// says "pure" is directly testable, and Tests/sync.test.js does test it.

// Rebuilds the day log from an event log. This is what makes Channel A work:
// two devices that have seen the same events derive the same log, whatever
// order the events arrived in.
//
// Note what is NOT set here: `inferred`. A derived day is a day that actually
// had events, which is the opposite of inferred — and the merge rule below is
// that a real record always beats a backfill guess.
function deriveDayLog(events) {
    const log = {};

    events.forEach((event) => {
        if (event.type !== EVENT_STAND && event.type !== EVENT_UNLOCK) return;

        const entry = log[event.date] || {
            stands: 0,
            unlocks: 0,
            sites: {},
            firstSlip: null,
            inferred: false
        };

        if (event.type === EVENT_STAND) {
            entry.stands += 1;
        } else {
            entry.unlocks += 1;

            if (event.domain) {
                entry.sites[event.domain] = (entry.sites[event.domain] || 0) + 1;
            }

            // Earliest slip of the day wins, across every device. "You gave way
            // at 23:14" is a fact about the day, not about the machine that
            // happened to witness it.
            if (event.time && (!entry.firstSlip || event.time < entry.firstSlip)) {
                entry.firstSlip = event.time;
            }
        }

        log[event.date] = entry;
    });

    return log;
}

// The resistance streak, recomputed rather than merged.
//
// It cannot be merged as a number. It counts stands since the last unlock, and
// once there is more than one device "the last unlock" is a global fact — a
// slip in the browser has to end a run of stands recorded in the desktop app.
// Taking the max would let a device that hasn't seen the slip keep counting;
// taking the min would throw away stands that really happened.
//
// So: sort every event by time, walk it, and count. The same walk yields the
// all-time longest, which is why they are returned together.
function deriveResistance(events) {
    const ordered = events
        .filter((e) => e.type === EVENT_STAND || e.type === EVENT_UNLOCK)
        .slice()
        .sort(compareEvents);

    let current = 0;
    let longest = 0;

    ordered.forEach((event) => {
        if (event.type === EVENT_UNLOCK) {
            current = 0;
            return;
        }

        current += 1;
        if (current > longest) longest = current;
    });

    return { currentResistance: current, longestResistance: longest };
}

// Total ordering across devices. `at` first; ties broken by id so two events
// recorded in the same millisecond on two machines still sort the same way on
// both of them. Without the tiebreak the two peers could derive different
// resistance runs from an identical set of events.
function compareEvents(a, b) {
    if (a.at !== b.at) return a.at - b.at;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

// The latest unlock across every device, as both a local date and a timestamp.
//
// The date is what the streak logic in Stats.js already consumes. The timestamp
// is new, and is what deriveResistance() needs — an ordering finer than a day,
// so a stand and a slip on the same date can be told apart.
function deriveLastUnlock(events) {
    let date = null;
    let at = 0;

    events.forEach((event) => {
        if (event.type !== EVENT_UNLOCK) return;
        if (date === null || event.date > date) date = event.date;
        if (event.at > at) at = event.at;
    });

    return { lastUnlockDate: date, lastUnlockAt: at };
}

// Sum of every device's all-time totals. Grow-only per device, so this can only
// ever go up, and a device that has been offline for a month contributes its
// whole history the moment it reconnects.
function sumCounters(counters) {
    let stands = 0;
    let unlocks = 0;

    Object.keys(counters || {}).forEach((deviceId) => {
        const entry = counters[deviceId] || {};
        stands += Math.max(0, Number(entry.stands) || 0);
        unlocks += Math.max(0, Number(entry.unlocks) || 0);
    });

    return { stayFocusedCount: stands, unlockCount: unlocks };
}

// ---- Channel A: merging events --------------------------------------------

// Set union by id. This is the entire merge for Channel A, and it is why the
// channel exists: two append-only logs cannot disagree, so there is no conflict
// to resolve and no rule that can be got wrong. Everything derived from them —
// the day log, both counters, the resistance streak, the escalation counts —
// inherits that.
function mergeEventLogs(mine, theirs, today) {
    const byId = new Map();

    normalizeEventLog(mine).forEach((event) => byId.set(event.id, event));
    normalizeEventLog(theirs).forEach((event) => {
        if (!byId.has(event.id)) byId.set(event.id, event);
    });

    return pruneEvents([...byId.values()].sort(compareEvents), today);
}

// Per-device max. A device's own total only ever grows, so the higher figure is
// always the more current one — and a device can never lower another's.
function mergeCounters(mine, theirs) {
    const merged = {};
    const sources = [mine || {}, theirs || {}];

    sources.forEach((source) => {
        Object.keys(source).forEach((deviceId) => {
            const entry = source[deviceId] || {};
            const held = merged[deviceId] || { stands: 0, unlocks: 0 };

            merged[deviceId] = {
                stands: Math.max(held.stands, Math.max(0, Number(entry.stands) || 0)),
                unlocks: Math.max(held.unlocks, Math.max(0, Number(entry.unlocks) || 0))
            };
        });
    });

    return merged;
}

// ---- Merging the day log --------------------------------------------------
//
// The derived log above covers every day inside the event window. This merges
// what is already stored — including days backfilled by the 1.10 seed, which
// have no events behind them and so cannot be derived.

function mergeDayLog(mine, theirs) {
    const merged = {};
    const dates = new Set([
        ...Object.keys(mine || {}),
        ...Object.keys(theirs || {})
    ]);

    dates.forEach((date) => {
        merged[date] = mergeDayEntry((mine || {})[date], (theirs || {})[date]);
    });

    return merged;
}

function mergeDayEntry(mine, theirs) {
    if (!mine) return normalizeDayEntry(theirs);
    if (!theirs) return normalizeDayEntry(mine);

    const a = normalizeDayEntry(mine);
    const b = normalizeDayEntry(theirs);

    const sites = Object.assign({}, a.sites);
    Object.keys(b.sites).forEach((domain) => {
        sites[domain] = (sites[domain] || 0) + b.sites[domain];
    });

    return {
        // Additive. Each device only witnessed its own share of the day, so
        // last-writer-wins would throw half a day away — and these counts are
        // what shade a square in the history grid, so the grid would be wrong
        // as well as the number.
        stands: a.stands + b.stands,
        unlocks: a.unlocks + b.unlocks,
        sites: sites,

        // Earliest wins: "first" is a fact about the day.
        firstSlip: earliestTime(a.firstSlip, b.firstSlip),

        // A real record always beats a backfill guess. Without this, a fresh
        // install joining an existing fortress would paint its own inferred
        // days over days another device actually witnessed.
        inferred: a.inferred && b.inferred
    };
}

function earliestTime(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return a < b ? a : b;
}

// Days derived from events beat days merged from storage, because an event is
// evidence and a stored count is a summary of evidence. Applied after
// mergeDayLog so a backfilled or pre-sync day still survives where no events
// reach.
function applyDerivedDays(log, derived) {
    const merged = Object.assign({}, log);

    Object.keys(derived).forEach((date) => {
        merged[date] = derived[date];
    });

    return merged;
}

// ---- Merging stats --------------------------------------------------------
//
// Only the fields that events cannot supply. The counters, the resistance pair
// and lastUnlock* all come from Channel A; currentStreak and lastCleanDate are
// re-derived by updateStreak() in Stats.js after the merge lands.

function mergeStats(mine, theirs) {
    const a = normalizeStats(mine);
    const b = normalizeStats(theirs);

    return Object.assign({}, a, {
        // High-water marks. A record can only go up, and has to survive a
        // device that has never seen it.
        longestStreak: Math.max(a.longestStreak, b.longestStreak),
        longestResistance: Math.max(a.longestResistance, b.longestResistance),

        // An unlock anywhere breaks the streak everywhere: the discipline is
        // about the person, not the device.
        lastUnlockDate: laterDate(a.lastUnlockDate, b.lastUnlockDate),
        lastUnlockAt: Math.max(a.lastUnlockAt || 0, b.lastUnlockAt || 0),

        // The fortress's history begins with the first device that recorded
        // anything, so the earliest stamp wins.
        historyStartedOn: earlierDate(a.historyStartedOn, b.historyStartedOn),

        // Once ANY device has seeded, no other device may. A fresh install that
        // has synced would otherwise infer days from its own empty streak and
        // write them over real history — see also `inferred` above, which is
        // the second half of the same guard.
        dayLogSeeded: a.dayLogSeeded || b.dayLogSeeded
    });
}

function laterDate(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return a > b ? a : b;
}

function earlierDate(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return a < b ? a : b;
}

// ---- Merging the friction state -------------------------------------------
//
// The three rules in this section are the ones where getting it wrong is not an
// inaccuracy but a bypass — a second device becoming a way around a wait the
// user already earned. The standing test for anything added here: does
// installing another peer make this friction cheaper? If it does, the merge
// rule is wrong.

// Today's unlocks per domain, counted from the event log.
//
// Escalating cooldowns are per-domain, per-day. If each device kept its own
// count you would unlock in Chrome at 1x, then in the desktop app at 1x, then
// in Edge at 1x, and escalation would simply never happen. It has to count the
// person.
//
// But it cannot be merged by ADDING the two stored counts, which is what this
// did first and what the round-trip test in Tests/sync.test.js caught: syncing
// a settled state again adds them a second time, and a minute later a third.
// Any merge that runs every minute forever has to be idempotent, and summing
// two summaries never is.
//
// So escalation is derived, not merged — the same rule the day log and the
// resistance streak already follow, and for the same reason. Two unlock events
// in the union are two unlocks however many times they are merged.
function deriveEscalation(events, today) {
    const day = today || todayLocal();
    const counts = {};

    events.forEach((event) => {
        if (event.type !== EVENT_UNLOCK || event.date !== day || !event.domain) return;
        counts[event.domain] = (counts[event.domain] || 0) + 1;
    });

    const derived = {};
    Object.keys(counts).forEach((domain) => {
        derived[domain] = { date: day, count: counts[domain] };
    });

    return derived;
}

// The count each peer will enforce: the derived figure, floored by whatever
// either side had already stored for today.
//
// The floor is what covers unlocks recorded before this version existed, which
// have a stored count but no event behind them. Max rather than sum keeps it
// idempotent — the worst case is that a pre-sync unlock isn't counted twice
// across devices, which is a small undercount in one day's escalation and not a
// number anyone can see.
//
// Entries from an earlier day are dropped on the way through, the same thing
// recordEscalationUnlock() already does and what resets the counter at midnight.
function mergeEscalation(mine, theirs, today, events) {
    const day = today || todayLocal();
    const merged = deriveEscalation(events || [], day);

    [mine || {}, theirs || {}].forEach((stored) => {
        Object.keys(stored).forEach((domain) => {
            const entry = stored[domain];
            if (!entry || entry.date !== day) return;

            const count = Math.max(0, Math.round(Number(entry.count) || 0));
            const held = merged[domain] ? merged[domain].count : 0;

            if (count > held) merged[domain] = { date: day, count: count };
        });
    });

    return merged;
}

// The escalating wait after a wrong seal is kept in storage rather than in the
// popup precisely so closing and reopening can't clear it. Syncing from a
// device that hasn't seen the failures would clear it just as effectively, so:
// max, never last-writer-wins.
function mergeSealAttempts(mine, theirs) {
    const a = normalizeSealAttempts(mine);
    const b = normalizeSealAttempts(theirs);

    return {
        failures: Math.max(a.failures, b.failures),
        lockedUntil: Math.max(a.lockedUntil, b.lockedUntil)
    };
}

// An unlock was paid for with a cooldown and a task, so honour it on both
// surfaces — taking the shorter expiry would cut short a window the user
// genuinely earned. What stops this being farmed is mergeEscalation() above:
// the second unlock of the day costs more than the first, wherever it happens.
function mergeTempUnlocks(mine, theirs, now) {
    const stamp = now || Date.now();
    const merged = {};
    const domains = new Set([
        ...Object.keys(mine || {}),
        ...Object.keys(theirs || {})
    ]);

    domains.forEach((domain) => {
        const expiry = Math.max(
            Number((mine || {})[domain]) || 0,
            Number((theirs || {})[domain]) || 0
        );

        // Expired unlocks are dropped rather than carried, the same cleanup
        // Background.js does when it meets one.
        if (expiry > stamp) merged[domain] = expiry;
    });

    return merged;
}

// One seal across every device. Only the PBKDF2 verifier travels — the password
// itself is never stored and so never sent, which was true before sync and
// stays true after.
//
// Setting or changing a seal is free; CLEARING one is a weakening and is
// handled by the authored path below, not here.
function mergeSeal(mine, theirs, myRev, theirRev) {
    const a = normalizeSeal(mine);
    const b = normalizeSeal(theirs);

    // A sealed fortress beats an unsealed one regardless of revision: gaining a
    // seal is strengthening, losing one is weakening, and weakening never
    // happens by merge.
    if (a.enabled !== b.enabled) return a.enabled ? a : b;

    const winner = theirRev > myRev ? b : a;

    // Recovery is the exception to taking the winner wholesale. Earliest start
    // wins, in both directions at once: a recovery must not be restartable to
    // stall it, and must not be shortenable by a device with a fast clock.
    const recovery = earliestRecovery(a.recovery, b.recovery);

    return Object.assign({}, winner, { recovery: recovery });
}

function earliestRecovery(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return a.requestedAt <= b.requestedAt ? a : b;
}

// ---- Channel B: merging the fortress --------------------------------------
//
// Strengthen-wins. Every rule below moves the fortress toward stricter, so no
// merge can take a defence down. The only thing that can is an authored record,
// written at the moment the user passed the seal or a friction gate.

// The machine-readable sibling of describeWeakening() in Seal.js. That function
// produces lines for a human to read on the prompt; this produces the same
// facts in a form a peer can apply.
function describeAuthoredWeakening(before, after) {
    const record = {
        categoriesRemoved: [],
        categoriesDisabled: [],
        sitesRemoved: {},
        standardsCleared: [],
        manualRemoved: [],
        taskCleared: false,
        cooldownLowered: null
    };

    const afterById = new Map((after.categories || []).map((c) => [c.id, c]));

    (before.categories || []).forEach((was) => {
        const now = afterById.get(was.id);

        if (!now) {
            record.categoriesRemoved.push(was.id);
            return;
        }

        if (was.enabled && !now.enabled) record.categoriesDisabled.push(was.id);

        const kept = new Set(now.sites || []);
        const dropped = (was.sites || []).filter((site) => !kept.has(site));
        if (dropped.length) record.sitesRemoved[was.id] = dropped;

        // A category giving up its own standards falls back to the fortress
        // default, which may well be weaker.
        if (("task" in was || "cooldown" in was) && !("task" in now) && !("cooldown" in now)) {
            record.standardsCleared.push(was.id);
        }
    });

    const keptManual = new Set(after.manualSites || []);
    record.manualRemoved = (before.manualSites || [])
        .filter((site) => !keptManual.has(site));

    if (before.task && !after.task) record.taskCleared = true;

    // The value, not a flag. A peer that is only told "this was lowered" has
    // nothing to lower TO — and it cannot work it out, because the merge it is
    // undoing already took the longer of the two. This is why a lowered
    // cooldown never actually crossed before: the flag was written, and the
    // peer that received it had no way to act on it.
    const wasCooldown = normalizeCooldown(before.cooldown);
    const nowCooldown = normalizeCooldown(after.cooldown);
    if (weakerCooldown(nowCooldown, wasCooldown)) {
        record.cooldownLowered = nowCooldown;
    }

    return isEmptyAuthored(record) ? null : record;
}

function isEmptyAuthored(record) {
    return !record.categoriesRemoved.length
        && !record.categoriesDisabled.length
        && !Object.keys(record.sitesRemoved).length
        && !record.standardsCleared.length
        && !record.manualRemoved.length
        && !record.taskCleared
        && !record.cooldownLowered;
}

// A record's id has to be the same string on every device that holds it, or the
// union below would keep re-adding the same weakening under a new name and the
// holder check would never find anyone. `device:rev` is that string: a device
// only ever raises its own revision, so the pair is unique to one commit.
//
// Records written before 1.12 carried no device at all — they were a single
// slot rather than a list, so nothing ever needed to name them. Those fall back
// to the revision and the timestamp together, which two peers would have to
// collide on within the same millisecond to confuse.
function authoredId(record) {
    if (record.device) return record.device + ":" + record.rev;
    return "legacy:" + record.rev + ":" + record.at;
}

function normalizeAuthored(raw) {
    if (!raw) return null;
    const source = raw || {};

    const sitesRemoved = {};
    const rawSites = source.sitesRemoved && typeof source.sitesRemoved === "object"
        ? source.sitesRemoved
        : {};

    Object.keys(rawSites).forEach((id) => {
        if (Array.isArray(rawSites[id])) sitesRemoved[id] = rawSites[id].map(String);
    });

    const record = {
        rev: Math.max(0, Math.round(Number(source.rev) || 0)),
        at: Math.max(0, Number(source.at) || 0),
        device: String(source.device || ""),
        categoriesRemoved: Array.isArray(source.categoriesRemoved) ? source.categoriesRemoved.map(String) : [],
        categoriesDisabled: Array.isArray(source.categoriesDisabled) ? source.categoriesDisabled.map(String) : [],
        sitesRemoved: sitesRemoved,
        standardsCleared: Array.isArray(source.standardsCleared) ? source.standardsCleared.map(String) : [],
        manualRemoved: Array.isArray(source.manualRemoved) ? source.manualRemoved.map(String) : [],
        taskCleared: source.taskCleared === true,
        // `true` is the pre-1.12 shape, which named no value to lower to. It
        // normalizes away rather than being guessed at: a record that cannot
        // say what the user chose has no business choosing for them.
        cooldownLowered: (source.cooldownLowered && typeof source.cooldownLowered === "object")
            ? normalizeCooldown(source.cooldownLowered)
            : null
    };

    record.id = String(source.id || authoredId(record));
    return record;
}

// Accepts either shape, because 1.11 stored one record and 1.12 stores a list.
// A fortress upgrading brings its last weakening with it rather than dropping
// it on the floor mid-sync.
function normalizeAuthoredList(raw) {
    if (!raw) return [];

    const list = Array.isArray(raw) ? raw : [raw];
    const seen = new Set();
    const out = [];

    list.forEach((entry) => {
        const record = normalizeAuthored(entry);
        if (!record || isEmptyAuthored(record)) return;
        if (seen.has(record.id)) return;
        seen.add(record.id);
        out.push(record);
    });

    return sortAuthored(out).slice(-AUTHORED_RETENTION);
}

// Oldest first, so replaying the list applies decisions in the order they were
// made — which only matters for the cooldown, where two records can both land
// and the later one is the one the user is living with.
function sortAuthored(records) {
    return records.slice().sort((a, b) => (a.at - b.at) || (a.rev - b.rev)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// How a weakening travels — the four rules
//
// The first design was one record, replaced on each commit, applied when
// `record.rev > myRev`. Six of the thirteen scenarios in Tests/authored.test.js
// fail against it, because revisions count commits PER DEVICE: one peer's 1 and
// another's 2 say nothing about which happened first, so two peers each
// removing something had BOTH removals silently ignored.
//
// What replaced it, and the scenario each rule exists for:
//
//   1. Records are a LIST, appended rather than replaced. Two removals before
//      one sync tick is an ordinary thing to do, and the single slot lost the
//      first — the category came back and nobody was told.
//
//   2. The list is KEPT on merge, and a peer adopts what it receives. A record
//      that was cleared on merge reached whoever was connected at the time and
//      was then forgotten, so a second browser that happened to be closed
//      pushed the category back on its return.
//
//   3. A removal lands only where every peer HOLDING the record is also WITHOUT
//      the thing. The record is the reason; that peer's fortress is the fact.
//      Without this, a removal the user reversed before syncing still travelled
//      — and applying a record twice needed bookkeeping instead of being
//      naturally a no-op.
//
//   4. Which is also rule 4 seen from the other side: a record YIELDS to a
//      decision made after it. If the far peer holds the record and still has
//      the thing, it was rebuilt knowingly. Replaying one's own records is
//      necessary — the union re-adds whatever either peer has — and without
//      this it silently undid that rebuild the moment it arrived.
//
// A peer that does NOT hold the record has simply never seen it, and its having
// the thing is not evidence of anything. That is the case a third peer makes
// ordinary: mobile, arriving in Phase 5, is a peer that was away.

// Fifty is far more than the handful a live fortress carries. A record is inert
// once every peer has both seen and agreed with it, so the list only grows when
// weakenings outpace syncing.
const AUTHORED_RETENTION = 50;

function mergeAuthored(mine, theirs) {
    const byId = new Map();
    normalizeAuthoredList(mine).forEach((record) => byId.set(record.id, record));
    normalizeAuthoredList(theirs).forEach((record) => {
        if (!byId.has(record.id)) byId.set(record.id, record);
    });

    return sortAuthored([...byId.values()]).slice(-AUTHORED_RETENTION);
}

function holdsAuthored(records, id) {
    return normalizeAuthoredList(records).some((record) => record.id === id);
}

// Merges two fortresses. Union first, then subtract what the records say was
// deliberately taken down.
//
// BOTH sides' records are replayed, every time, and each one is checked against
// whoever is holding it — see the four rules above mergeAuthored(). Replaying
// one's own is not redundant: the union has just re-added whatever the peer
// still has, so a removal this device made has to be re-stated on every merge
// until the peer has adopted it too.
function mergeFortress(mine, theirs, myRev, theirRev, myAuthored, theirAuthored) {
    const merged = {
        categories: mergeCategories(mine.categories, theirs.categories, myRev, theirRev),
        manualSites: unionSites(mine.manualSites, theirs.manualSites),
        task: mergeTask(mine.task, theirs.task, myRev, theirRev),
        cooldown: mergeCooldown(mine.cooldown, theirs.cooldown)
    };

    mergeAuthored(myAuthored, theirAuthored).forEach((record) => {
        // The fortresses of the peers that hold this record. A peer that does
        // not hold it has never seen it, and what it has is not evidence.
        const holders = [];
        if (holdsAuthored(myAuthored, record.id)) holders.push(mine);
        if (holdsAuthored(theirAuthored, record.id)) holders.push(theirs);
        applyAuthored(merged, record, holders);
    });

    return merged;
}

function unionSites(mine, theirs) {
    return [...new Set([...(mine || []), ...(theirs || [])])];
}

function mergeCategories(mine, theirs, myRev, theirRev) {
    const merged = [];
    const seen = new Set();
    const theirsById = new Map((theirs || []).map((c) => [c.id, c]));
    const mineById = new Map((mine || []).map((c) => [c.id, c]));

    // Order comes from whichever side committed most recently. Order is
    // meaningful in Dominus — when a domain sits in more than one enabled
    // category, the earliest one governs its task — so it can't be arbitrary,
    // but neither ordering is "stronger" than the other.
    const leading = theirRev > myRev ? (theirs || []) : (mine || []);
    const trailing = theirRev > myRev ? (mine || []) : (theirs || []);

    leading.concat(trailing).forEach((category) => {
        if (seen.has(category.id)) return;
        seen.add(category.id);

        merged.push(mergeCategory(
            mineById.get(category.id),
            theirsById.get(category.id),
            myRev,
            theirRev
        ));
    });

    return merged;
}

function mergeCategory(mine, theirs, myRev, theirRev) {
    if (!mine) return theirs;
    if (!theirs) return mine;

    // Cosmetic fields have no stronger direction, so they follow the newer
    // commit. Everything else resolves toward stricter.
    const newer = theirRev > myRev ? theirs : mine;

    const merged = {
        id: mine.id,
        name: newer.name,
        color: newer.color,
        glyph: newer.glyph,
        sites: unionSites(mine.sites, theirs.sites),
        enabled: mine.enabled || theirs.enabled,
        permanent: mine.permanent || theirs.permanent
    };

    // A category with its own standards beats one that inherits: an override is
    // set deliberately, and dropping it falls back to the fortress default,
    // which may be weaker.
    const task = mergeOverride(mine, theirs, "task", newer);
    if (task !== undefined) merged.task = task;

    const cooldown = mergeOverride(mine, theirs, "cooldown", newer);
    if (cooldown !== undefined) {
        merged.cooldown = ("cooldown" in mine && "cooldown" in theirs)
            ? mergeCooldown(mine.cooldown, theirs.cooldown)
            : cooldown;
    }

    return merged;
}

function mergeOverride(mine, theirs, key, newer) {
    const inMine = key in mine;
    const inTheirs = key in theirs;

    if (!inMine && !inTheirs) return undefined;
    if (inMine && !inTheirs) return mine[key];
    if (!inMine && inTheirs) return theirs[key];
    return newer[key];
}

// Having a task beats not having one — removing a task is a weakening, already
// gated in the UI, and a merge must not become a way around that gate. Two
// different tasks are not orderable (a Random Passage is not stricter than a
// Guarded Code), so the newer commit settles it.
function mergeTask(mine, theirs, myRev, theirRev) {
    if (mine && !theirs) return mine;
    if (!mine && theirs) return theirs;
    if (!mine && !theirs) return null;
    return theirRev > myRev ? theirs : mine;
}

// Longer and escalating are stronger. The MAX_COOLDOWN_SECONDS ceiling in
// Tasks.js still applies downstream in effectiveCooldownSeconds(), so merging
// cannot manufacture the permanent lockout that cap exists to prevent.
function mergeCooldown(mine, theirs) {
    const a = normalizeCooldown(mine);
    const b = normalizeCooldown(theirs);

    return normalizeCooldown({
        seconds: Math.max(a.seconds, b.seconds),
        escalate: a.escalate || b.escalate,
        factor: Math.max(a.factor, b.factor)
    });
}

// Subtracts one deliberate weakening from the merged result. Mutates `merged`.
//
// `holders` are the fortresses of the peers that hold this record. Every item
// is gated on all of them being WITHOUT it: the record is the reason a defence
// came down, and a holder that still has the thing rebuilt it knowingly after
// writing the record. Gating item by item rather than record by record matters
// because one commit can take three things down and the user can put one of
// them back — the other two should still travel.
function applyAuthored(merged, authored, holders) {
    const peers = holders || [];
    const without = (predicate) => peers.every((peer) => !predicate(peer));

    const removed = new Set(authored.categoriesRemoved
        .filter((id) => without((peer) => findCategory(peer, id))));

    // A holder that no longer has the category at all counts as without it —
    // it cannot be holding an enabled one.
    const disabled = new Set(authored.categoriesDisabled
        .filter((id) => without((peer) => {
            const category = findCategory(peer, id);
            return category && category.enabled;
        })));

    const cleared = new Set(authored.standardsCleared
        .filter((id) => without((peer) => {
            const category = findCategory(peer, id);
            return category && ("task" in category || "cooldown" in category);
        })));

    const manualGone = new Set(authored.manualRemoved
        .filter((site) => without((peer) => (peer.manualSites || []).includes(site))));

    merged.categories = merged.categories
        .filter((category) => !removed.has(category.id))
        .map((category) => {
            const next = Object.assign({}, category);

            if (disabled.has(next.id)) {
                next.enabled = false;
                // Permanence cannot outlive being switched off — the same rule
                // normalizeCategoryList() enforces, applied here so a merge
                // can't leave a stale flag to re-apply on the next tick.
                next.permanent = false;
            }

            const dropped = (authored.sitesRemoved[next.id] || []).filter((site) => without((peer) => {
                const category = findCategory(peer, next.id);
                return category && (category.sites || []).includes(site);
            }));

            if (dropped.length) {
                const gone = new Set(dropped);
                next.sites = (next.sites || []).filter((site) => !gone.has(site));
            }

            if (cleared.has(next.id)) {
                delete next.task;
                delete next.cooldown;
            }

            return next;
        });

    merged.manualSites = merged.manualSites.filter((site) => !manualGone.has(site));

    if (authored.taskCleared && without((peer) => peer.task)) merged.task = null;

    // A holder whose cooldown is still stronger than the recorded one raised it
    // again after the record was written, which is a later decision and wins.
    if (authored.cooldownLowered
        && without((peer) => weakerCooldown(authored.cooldownLowered, peer.cooldown))) {
        merged.cooldown = normalizeCooldown(authored.cooldownLowered);
    }
}

function findCategory(fortress, id) {
    return (fortress.categories || []).find((category) => category.id === id) || null;
}

// Is `a` a weaker standard than `b`? The same three fields mergeCooldown()
// resolves toward stricter, read in the other direction.
function weakerCooldown(a, b) {
    const one = normalizeCooldown(a);
    const two = normalizeCooldown(b);
    return one.seconds < two.seconds
        || (two.escalate && !one.escalate)
        || (one.escalate && two.escalate && one.factor < two.factor);
}

// ---- The whole merge ------------------------------------------------------

// One peer state, as sent and received. Pure, so a test can hand it two objects
// and check the result without a browser anywhere near it.
//
// `blockedSites` is deliberately absent from both the input and the output. It
// is a cache of the categories and the manual list, read by Background.js on
// every navigation, and the caller re-derives it with computeBlockedSites()
// after applying this. Sending it would let what is enforced drift from what is
// shown, which is the failure writeFortress() was written to prevent.
function mergePeerState(mine, theirs, now) {
    const today = (mine.today || theirs.today || null);
    const stamp = now || 0;

    const events = mergeEventLogs(mine.events, theirs.events, today);
    const counters = mergeCounters(mine.counters, theirs.counters);
    const fortressRev = Math.max(mine.fortressRev || 0, theirs.fortressRev || 0);

    const stats = mergeStats(mine.stats, theirs.stats);
    const derived = deriveDayLog(events);
    const lastUnlock = deriveLastUnlock(events);
    const resistance = deriveResistance(events);
    const totals = sumCounters(counters);

    // Events are evidence, so what they say wins over what either side had
    // summarised — but only where they reach. lastUnlockDate falls back to the
    // merged stats for a fortress whose last slip is older than the event
    // window.
    Object.assign(stats, totals, resistance, {
        lastUnlockDate: laterDate(stats.lastUnlockDate, lastUnlock.lastUnlockDate),
        lastUnlockAt: Math.max(stats.lastUnlockAt || 0, lastUnlock.lastUnlockAt),
        longestResistance: Math.max(stats.longestResistance, resistance.longestResistance)
    });

    return {
        events: events,
        counters: counters,
        fortressRev: fortressRev,
        stats: stats,
        dayLog: applyDerivedDays(mergeDayLog(mine.dayLog, theirs.dayLog), derived),
        fortress: mergeFortress(
            mine.fortress || {},
            theirs.fortress || {},
            mine.fortressRev || 0,
            theirs.fortressRev || 0,
            mine.authored,
            theirs.authored
        ),
        // Kept, not consumed. A record that was cleared on merge reached only
        // whoever was connected at the time, and a peer that was closed pushed
        // the defence back on its return.
        authored: mergeAuthored(mine.authored, theirs.authored),
        seal: mergeSeal(mine.seal, theirs.seal, mine.fortressRev || 0, theirs.fortressRev || 0),
        sealAttempts: mergeSealAttempts(mine.sealAttempts, theirs.sealAttempts),
        escalation: mergeEscalation(mine.escalation, theirs.escalation, today, events),
        tempUnlocks: mergeTempUnlocks(mine.tempUnlocks, theirs.tempUnlocks, stamp)
    };
}

// ---- Transport ------------------------------------------------------------
//
// There is no peer yet. This is the seam the desktop app arrives at in Phase 1,
// and it is left as a no-op on purpose: the merge rules above are the part that
// is expensive to get wrong once two peers are in the wild, so they ship and
// get exercised first, against a transport that cannot lose anything because it
// cannot send anything.
//
// When the desktop app lands, setSyncTransport() takes a function that posts
// this device's state to http://127.0.0.1:PORT and resolves with the peer's.
// Nothing above this line changes.

let syncTransport = null;

function setSyncTransport(transport) {
    syncTransport = typeof transport === "function" ? transport : null;
}

// Everything this device would send a peer.
function readPeerState() {
    return ensureCountersSeeded().then(() => Promise.all([
        getEventLogRaw(),
        getSyncMetaRaw(),
        getStatsRaw(),
        getDayLogRaw(),
        readFortress(),
        loadSeal(),
        loadSealAttempts(),
        readKey(ESCALATION_KEY),
        readKey("tempUnlocks")
    ]).then(([events, meta, stats, dayLog, fortress, seal, sealAttempts, escalation, tempUnlocks]) => ({
        today: todayLocal(),
        events: events,
        counters: meta.counters,
        fortressRev: meta.fortressRev,
        authored: meta.authored,
        stats: stats,
        dayLog: dayLog,
        fortress: fortress,
        seal: seal,
        sealAttempts: sealAttempts,
        escalation: escalation || {},
        tempUnlocks: tempUnlocks || {}
    })));
}

function readKey(key) {
    return new Promise((resolve) => {
        chrome.storage.local.get([key], (result) => resolve(result[key]));
    });
}

// Resolves { status } — "no-peer" until a transport is installed. Called after
// every local write and on the alarm tick in Background.js, both of which are
// wired now so the cadence is real by the time there is something to send.
function syncNow() {
    if (!syncTransport) return Promise.resolve({ status: "no-peer" });

    return readPeerState()
        .then((mine) => syncTransport(mine).then((theirs) => {
            if (!theirs) return { status: "no-peer" };
            return applyMerge(mergePeerState(mine, theirs, Date.now()));
        }))
        .catch((error) => ({ status: "failed", error: String(error) }));
}

// Writes a merged state back to storage. blockedSites is re-derived here rather
// than taken from the merge, for the reason given on mergePeerState().
function applyMerge(merged) {
    const blockedSites = computeBlockedSites(
        merged.fortress.categories,
        merged.fortress.manualSites
    );

    return new Promise((resolve) => {
        chrome.storage.local.set({
            [SYNC_EVENTS_KEY]: merged.events,
            [SYNC_META_KEY]: normalizeSyncMeta({
                fortressRev: merged.fortressRev,
                counters: merged.counters,
                authored: merged.authored,
                lastSyncedAt: Date.now(),
                // Always true after a merge, and not merely carried over.
                // Once counters have been merged they hold totals from other
                // devices too, while stats holds the sum of all of them — so
                // seeding this device from stats would hand it everyone else's
                // history as its own. Letting the flag reset here is what made
                // importing the same backup twice report 428 stands for 214.
                countersSeeded: true
            }),
            stats: merged.stats,
            [DAY_LOG_KEY]: merged.dayLog,
            [CATEGORY_DEFS_KEY]: merged.fortress.categories,
            [MANUAL_SITES_KEY]: merged.fortress.manualSites,
            blockedSites: blockedSites,
            unlockTask: merged.fortress.task,
            cooldownSettings: normalizeCooldown(merged.fortress.cooldown),
            [SEAL_KEY]: merged.seal,
            [SEAL_ATTEMPTS_KEY]: merged.sealAttempts,
            [ESCALATION_KEY]: merged.escalation,
            tempUnlocks: merged.tempUnlocks
        }, () => resolve({ status: "merged", blockedSites: blockedSites }));
    });
}

// Node's test runner loads this file directly to exercise the pure functions
// above. Guarded so the browser, which has no `module`, ignores it entirely —
// the same dependency-free classic-script contract the rest of the file keeps.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        mergeEventLogs,
        mergeCounters,
        sumCounters,
        deriveDayLog,
        deriveResistance,
        deriveLastUnlock,
        mergeDayLog,
        mergeDayEntry,
        mergeStats,
        mergeEscalation,
        deriveEscalation,
        mergeSealAttempts,
        mergeTempUnlocks,
        mergeSeal,
        mergeFortress,
        mergeCooldown,
        mergeTask,
        describeAuthoredWeakening,
        normalizeAuthored,
        normalizeAuthoredList,
        mergeAuthored,
        authoredId,
        weakerCooldown,
        mergePeerState,
        applyDerivedDays,
        normalizeSyncMeta,
        EVENT_STAND,
        EVENT_UNLOCK,
        EVENT_COMMIT,
        EVENT_RETENTION_DAYS
    };
}
