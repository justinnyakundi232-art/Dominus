// Tests/sync.test.js — the merge rules, exercised against synthetic peers.
//
//     node Tests/sync.test.js
//
// No dependencies and no test framework, matching the rest of the project. The
// merge rules in Sync.js are the part of the desktop split that is expensive to
// change once two peers are in the wild, so they are the part that gets tested
// first — before there is a second peer to get them wrong against.
//
// Every case below is a rule from the plan. The ones marked BYPASS are the
// three where getting the merge wrong doesn't produce a wrong number, it
// produces a way around friction the user already earned. Those matter most.

// Every function tested here is pure — no storage, no chrome, no clock — which
// is why they can be handed two synthetic peers and checked directly.
const { loadSharedLayer, createHarness } = require("./load");

const S = loadSharedLayer().api;
const { describe, it, eq, ok, report } = createHarness();

// ---- Fixtures -------------------------------------------------------------

let seq = 0;

function stand(device, date, at) {
    return { id: `e${seq++}`, type: S.EVENT_STAND, device, date, at };
}

function unlock(device, date, at, domain, time) {
    return { id: `e${seq++}`, type: S.EVENT_UNLOCK, device, date, at, domain, time };
}

function category(overrides) {
    return Object.assign({
        id: "gaming",
        name: "Gaming",
        color: "verdant",
        glyph: "●",
        sites: ["roblox.com"],
        enabled: true,
        permanent: false
    }, overrides);
}

// ===========================================================================
describe("Channel A — the event log");

it("union by id is order-independent and idempotent", () => {
    const a = stand("chrome", "2026-08-30", 100);
    const b = unlock("desktop", "2026-08-30", 200, "youtube.com", "14:00");
    const c = stand("desktop", "2026-08-31", 300);

    const forward = S.mergeEventLogs([a, b], [b, c], "2026-08-31");
    const backward = S.mergeEventLogs([c, b], [b, a], "2026-08-31");

    eq(forward.map((e) => e.id), backward.map((e) => e.id), "order changed the result");
    eq(forward.length, 3, "the shared event was counted twice");

    // Merging the result back into itself must change nothing. This is what
    // makes a sync safe to run every minute forever.
    const again = S.mergeEventLogs(forward, forward, "2026-08-31");
    eq(again.map((e) => e.id), forward.map((e) => e.id), "merge is not idempotent");
});

it("a day log derived from two devices sums both", () => {
    const events = [
        stand("chrome", "2026-08-30", 100),
        stand("chrome", "2026-08-30", 110),
        stand("desktop", "2026-08-30", 120),
        unlock("desktop", "2026-08-30", 130, "youtube.com", "23:46")
    ];

    const log = S.deriveDayLog(events);

    eq(log["2026-08-30"].stands, 3, "stands from one device were dropped");
    eq(log["2026-08-30"].unlocks, 1);
    eq(log["2026-08-30"].sites, { "youtube.com": 1 });
    eq(log["2026-08-30"].inferred, false, "a witnessed day must never be inferred");
});

it("firstSlip is the earliest across devices, not the last one merged", () => {
    const events = [
        unlock("desktop", "2026-08-30", 900, "reddit.com", "22:10"),
        unlock("chrome", "2026-08-30", 100, "youtube.com", "09:05")
    ];

    // "You gave way at 09:05" is a fact about the day. The device that happened
    // to witness it has nothing to do with it.
    eq(S.deriveDayLog(events)["2026-08-30"].firstSlip, "09:05");
});

it("a slip on one device ends a run of stands on the other", () => {
    // The case that cannot be merged as a number: taking the max would let the
    // device that never saw the slip keep counting; taking the min would throw
    // away stands that really happened.
    const events = [
        stand("chrome", "2026-08-30", 100),
        stand("chrome", "2026-08-30", 200),
        stand("chrome", "2026-08-30", 300),
        unlock("desktop", "2026-08-30", 350, "youtube.com", "12:00"),
        stand("chrome", "2026-08-30", 400)
    ];

    const derived = S.deriveResistance(events);
    eq(derived.currentResistance, 1, "the slip did not end the run");
    eq(derived.longestResistance, 3, "the high-water mark was lost");
});

it("resistance is the same whichever order the events arrive in", () => {
    const events = [
        stand("chrome", "2026-08-30", 100),
        unlock("desktop", "2026-08-30", 350, "youtube.com", "12:00"),
        stand("chrome", "2026-08-30", 400),
        stand("desktop", "2026-08-30", 500)
    ];

    const forward = S.deriveResistance(events);
    const shuffled = S.deriveResistance(events.slice().reverse());
    eq(forward, shuffled, "arrival order changed the streak");
});

it("events past the retention window are dropped identically on both peers", () => {
    const old = stand("chrome", "2020-01-01", 1);
    const fresh = stand("chrome", "2026-08-30", 2);

    const merged = S.mergeEventLogs([old, fresh], [old], "2026-08-31");
    eq(merged.map((e) => e.id), [fresh.id], "the retention window did not apply");
});

// ===========================================================================
describe("Counters");

it("two devices each recording one stand total two, not one", () => {
    // The plain last-writer-wins failure: both devices say "1", LWW says 1, and
    // the victory rate is quietly wrong forever.
    const merged = S.mergeCounters(
        { chrome: { stands: 1, unlocks: 0 } },
        { desktop: { stands: 1, unlocks: 0 } }
    );

    eq(S.sumCounters(merged), { stayFocusedCount: 2, unlockCount: 0 });
});

it("a device's own total can only be raised, never lowered by a peer", () => {
    // A stale peer holding an old view of this device must not roll it back.
    const merged = S.mergeCounters(
        { chrome: { stands: 40, unlocks: 3 } },
        { chrome: { stands: 12, unlocks: 1 } }
    );

    eq(merged.chrome, { stands: 40, unlocks: 3 });
});

// ===========================================================================
describe("BYPASS — friction that a second device must not make cheaper");

it("escalating cooldowns count the person, not the device", () => {
    // Without this: unlock in Chrome at 1x, then in the desktop app at 1x, then
    // in Edge at 1x, and escalation never happens at all.
    const events = [
        unlock("chrome", "2026-08-31", 100, "youtube.com", "09:00"),
        unlock("desktop", "2026-08-31", 200, "youtube.com", "14:00")
    ];

    const merged = S.mergeEscalation(
        { "youtube.com": { date: "2026-08-31", count: 1 } },
        { "youtube.com": { date: "2026-08-31", count: 1 } },
        "2026-08-31",
        events
    );

    eq(merged["youtube.com"], { date: "2026-08-31", count: 2 },
        "each device kept its own count — escalation is bypassable");
});

it("escalation does not compound when the same state syncs again", () => {
    // The tick runs every minute forever, so summing two stored counts inflates
    // them without bound. Derived from events, two unlocks stay two unlocks
    // however many times the merge runs.
    const events = [
        unlock("chrome", "2026-08-31", 100, "youtube.com", "09:00"),
        unlock("desktop", "2026-08-31", 200, "youtube.com", "14:00")
    ];
    const settled = { "youtube.com": { date: "2026-08-31", count: 2 } };

    eq(S.mergeEscalation(settled, settled, "2026-08-31", events), settled,
        "escalation compounds on repeat syncs");
});

it("an unlock recorded before the event log still counts", () => {
    // Upgrading fortresses have a stored count and no event behind it. The
    // stored figure is a floor, so it can't be lost — just not double-counted.
    const merged = S.mergeEscalation(
        { "youtube.com": { date: "2026-08-31", count: 3 } },
        {},
        "2026-08-31",
        []
    );

    eq(merged["youtube.com"], { date: "2026-08-31", count: 3 });
});

it("yesterday's escalation still resets at midnight", () => {
    const merged = S.mergeEscalation(
        { "youtube.com": { date: "2026-08-30", count: 9 } },
        { "youtube.com": { date: "2026-08-30", count: 9 } },
        "2026-08-31",
        [unlock("chrome", "2026-08-30", 100, "youtube.com", "09:00")]
    );

    eq(merged, {}, "a stale day survived the reset");
});

it("the seal's escalating wait cannot be cleared by syncing", () => {
    // The wait lives in storage precisely so closing the popup can't clear it.
    // A peer that hasn't seen the failures would clear it just as effectively.
    const merged = S.mergeSealAttempts(
        { failures: 4, lockedUntil: 1_800_000 },
        { failures: 0, lockedUntil: 0 }
    );

    eq(merged, { failures: 4, lockedUntil: 1_800_000 },
        "a fresh peer wiped an earned lockout");
});

it("a seal recovery cannot be restarted to stall it, or shortened to rush it", () => {
    const early = { enabled: true, salt: "s", verifier: "v", recovery: { requestedAt: 1000 } };
    const late = { enabled: true, salt: "s", verifier: "v", recovery: { requestedAt: 9000 } };

    eq(S.mergeSeal(early, late, 1, 2).recovery.requestedAt, 1000,
        "a later start won — the recovery is restartable");
    eq(S.mergeSeal(late, early, 2, 1).recovery.requestedAt, 1000,
        "the rule is not symmetric");
});

it("a temporary unlock that was paid for is honoured on both surfaces", () => {
    const merged = S.mergeTempUnlocks(
        { "youtube.com": 5000 },
        { "youtube.com": 9000, "reddit.com": 100 },
        1000
    );

    eq(merged["youtube.com"], 9000, "an earned window was cut short");
    ok(!("reddit.com" in merged), "an expired unlock was carried across");
});

// ===========================================================================
describe("Channel B — strengthen-wins");

it("a category switched off on one device stays on after a plain merge", () => {
    // No authored record, so this is two views crossing in the post rather than
    // a decision. The fortress must not come down by accident.
    const merged = S.mergeFortress(
        { categories: [category({ enabled: true })], manualSites: [], task: null, cooldown: null },
        { categories: [category({ enabled: false })], manualSites: [], task: null, cooldown: null },
        1, 2, null
    );

    eq(merged.categories[0].enabled, true, "a defence came down without anyone deciding to");
});

it("sites union rather than one side's list winning", () => {
    const merged = S.mergeFortress(
        { categories: [category({ sites: ["roblox.com"] })], manualSites: ["a.com"], task: null, cooldown: null },
        { categories: [category({ sites: ["steamcommunity.com"] })], manualSites: ["b.com"], task: null, cooldown: null },
        1, 2, null
    );

    eq(merged.categories[0].sites.sort(), ["roblox.com", "steamcommunity.com"]);
    eq(merged.manualSites.sort(), ["a.com", "b.com"]);
});

it("having an unlock task beats having none", () => {
    const task = { id: "randomPassage" };
    eq(S.mergeTask(task, null, 1, 2), task, "a newer commit removed a task by merge");
    eq(S.mergeTask(null, task, 2, 1), task);
});

it("the longer, escalating cooldown wins", () => {
    const merged = S.mergeCooldown(
        { seconds: 600, escalate: false, factor: 1.25 },
        { seconds: 120, escalate: true, factor: 2 }
    );

    eq(merged.seconds, 600);
    eq(merged.escalate, true);
    eq(merged.factor, 2);
});

it("a deliberate removal does cross to the other device", () => {
    const before = {
        categories: [category({ id: "gaming" }), category({ id: "social", sites: ["x.com"] })],
        manualSites: ["news.com"],
        task: { id: "randomPassage" },
        cooldown: { seconds: 600, escalate: true, factor: 1.5 }
    };
    const after = {
        categories: [category({ id: "gaming" })],
        manualSites: [],
        task: null,
        cooldown: { seconds: 60, escalate: false, factor: 1.5 }
    };

    const authored = S.describeAuthoredWeakening(before, after);
    ok(authored, "a real weakening produced no record");
    eq(authored.categoriesRemoved, ["social"]);
    eq(authored.manualRemoved, ["news.com"]);
    eq(authored.taskCleared, true);
    eq(authored.cooldownLowered, true);

    // The peer applies it, because it is newer than anything this device did.
    const merged = S.mergeFortress(
        before, after, 1, 2,
        Object.assign({ rev: 2, at: Date.now() }, authored)
    );

    eq(merged.categories.map((c) => c.id), ["gaming"], "the removal did not cross");
    eq(merged.manualSites, []);
    eq(merged.task, null);
});

it("a stale removal cannot replay over a defence that was put back", () => {
    // The peer's record is older than this device's own commit, so the user has
    // since rebuilt what it describes taking down. Replaying it would undo a
    // deliberate act with a stale one.
    const before = { categories: [category({ id: "social" })], manualSites: [], task: null, cooldown: null };
    const after = { categories: [], manualSites: [], task: null, cooldown: null };

    const merged = S.mergeFortress(
        before, after, 9, 2,
        Object.assign({ rev: 2, at: 0 }, S.describeAuthoredWeakening(before, after))
    );

    eq(merged.categories.map((c) => c.id), ["social"], "a stale removal replayed");
});

it("no weakening produces no record", () => {
    const state = { categories: [category({})], manualSites: [], task: null, cooldown: null };
    const stronger = {
        categories: [category({ sites: ["roblox.com", "steamcommunity.com"] })],
        manualSites: ["extra.com"],
        task: { id: "randomPassage" },
        cooldown: null
    };

    eq(S.describeAuthoredWeakening(state, stronger), null,
        "strengthening the fortress asked to be authored");
});

it("permanence cannot outlive being switched off", () => {
    const before = { categories: [category({ enabled: true, permanent: true })], manualSites: [], task: null, cooldown: null };
    const after = { categories: [category({ enabled: false, permanent: false })], manualSites: [], task: null, cooldown: null };

    const merged = S.mergeFortress(
        before, after, 1, 2,
        Object.assign({ rev: 2, at: 0 }, S.describeAuthoredWeakening(before, after))
    );

    eq(merged.categories[0].enabled, false);
    eq(merged.categories[0].permanent, false, "a stale permanence flag survived");
});

// ===========================================================================
describe("The day log and stats");

it("a real record beats a backfilled guess", () => {
    // A fresh install joining an existing fortress must not paint its own
    // inferred days over days another device actually witnessed.
    const merged = S.mergeDayEntry(
        { stands: 0, unlocks: 0, sites: {}, firstSlip: null, inferred: true },
        { stands: 4, unlocks: 0, sites: {}, firstSlip: null, inferred: false }
    );

    eq(merged.inferred, false);
    eq(merged.stands, 4);
});

it("high-water marks survive a device that has never seen them", () => {
    const merged = S.mergeStats(
        { longestStreak: 31, longestResistance: 88, historyStartedOn: "2026-08-01", dayLogSeeded: true },
        { longestStreak: 2, longestResistance: 3, historyStartedOn: "2026-03-14", dayLogSeeded: false }
    );

    eq(merged.longestStreak, 31);
    eq(merged.longestResistance, 88);
    eq(merged.historyStartedOn, "2026-03-14", "history must start at the earliest record");
    eq(merged.dayLogSeeded, true, "a synced device may not run the backfill again");
});

it("an unlock anywhere breaks the streak everywhere", () => {
    const merged = S.mergeStats(
        { lastUnlockDate: "2026-08-01", lastUnlockAt: 100 },
        { lastUnlockDate: "2026-08-29", lastUnlockAt: 900 }
    );

    eq(merged.lastUnlockDate, "2026-08-29");
    eq(merged.lastUnlockAt, 900);
});

// ===========================================================================
describe("End to end");

it("two peers merge to the same state from either side", () => {
    // A stand recorded on Chrome that the desktop app has already seen. It must
    // survive the merge exactly once, from either direction.
    const shared = stand("chrome", "2026-08-30", 100);

    // Both devices unlocked youtube.com today. Each saw only its own, so each
    // stored an escalation count of 1 — and the merged fortress has to charge
    // the second unlock as a second unlock.
    const chromeSlip = unlock("chrome", "2026-08-31", 400, "youtube.com", "21:00");
    const desktopSlip = unlock("desktop", "2026-08-31", 600, "youtube.com", "22:00");
    const desktopStand = stand("desktop", "2026-08-31", 500);

    const chrome = {
        today: "2026-08-31",
        events: [shared, chromeSlip],
        counters: { chrome: { stands: 1, unlocks: 1 } },
        fortressRev: 3,
        authored: null,
        stats: { longestStreak: 10, dayLogSeeded: true, historyStartedOn: "2026-06-01" },
        dayLog: {},
        fortress: { categories: [category({})], manualSites: ["a.com"], task: null, cooldown: null },
        seal: { enabled: false },
        sealAttempts: { failures: 2, lockedUntil: 500 },
        escalation: { "youtube.com": { date: "2026-08-31", count: 1 } },
        tempUnlocks: { "youtube.com": 99_000 }
    };

    const desktop = {
        today: "2026-08-31",
        events: [shared, desktopStand, desktopSlip],
        counters: { desktop: { stands: 1, unlocks: 1 } },
        fortressRev: 2,
        authored: null,
        stats: { longestStreak: 4, dayLogSeeded: false, historyStartedOn: "2026-07-01" },
        dayLog: {},
        fortress: { categories: [category({ sites: ["epicgames.com"] })], manualSites: ["b.com"], task: null, cooldown: null },
        seal: { enabled: false },
        sealAttempts: { failures: 0, lockedUntil: 0 },
        escalation: { "youtube.com": { date: "2026-08-31", count: 1 } },
        tempUnlocks: {}
    };

    const a = S.mergePeerState(chrome, desktop, 1000);
    const b = S.mergePeerState(desktop, chrome, 1000);

    // Convergence: whichever side runs the merge, both land in the same place.
    // Without this, two peers can sync forever and never agree.
    eq(a.events.map((e) => e.id), b.events.map((e) => e.id), "event logs diverged");
    eq(a.stats.stayFocusedCount, b.stats.stayFocusedCount, "counters diverged");
    eq(a.escalation, b.escalation, "escalation diverged");
    eq(a.sealAttempts, b.sealAttempts, "seal attempts diverged");
    eq(
        a.fortress.categories[0].sites.slice().sort(),
        b.fortress.categories[0].sites.slice().sort(),
        "the fortress diverged"
    );

    eq(a.stats.stayFocusedCount, 2, "stands were lost across the merge");
    eq(a.stats.unlockCount, 2, "unlocks were lost across the merge");
    eq(a.escalation["youtube.com"].count, 2,
        "the second unlock of the day was charged as the first");
    eq(a.sealAttempts.failures, 2);
    eq(a.stats.dayLogSeeded, true);
    eq(a.stats.lastUnlockAt, 600, "the later slip did not win");
    eq(a.dayLog["2026-08-31"].stands, 1);
    eq(a.dayLog["2026-08-31"].unlocks, 2);
    eq(a.dayLog["2026-08-31"].firstSlip, "21:00", "firstSlip took the later one");
    eq(a.fortress.manualSites.slice().sort(), ["a.com", "b.com"]);
    eq(a.tempUnlocks["youtube.com"], 99_000);

    // And a settled state, synced again, must not move. This is the property
    // that matters most in practice: the tick runs every minute forever, so any
    // rule that isn't idempotent compounds. It is what caught escalation being
    // summed rather than derived.
    const twice = S.mergePeerState(asPeer(a), asPeer(a), 1000);

    eq(twice.stats.stayFocusedCount, a.stats.stayFocusedCount,
        "a second sync of settled state moved the counters");
    eq(twice.stats.unlockCount, a.stats.unlockCount);
    eq(twice.escalation, a.escalation,
        "a second sync of settled state double-counted escalation");
    eq(twice.dayLog, a.dayLog, "a second sync of settled state moved the day log");
    eq(twice.events.map((e) => e.id), a.events.map((e) => e.id));
    eq(twice.fortress.manualSites.slice().sort(),
        a.fortress.manualSites.slice().sort());
});

// A merge result, dressed back up as the peer state a device would send on the
// next tick. The shapes differ by exactly the two fields the merge consumes
// rather than produces.
function asPeer(merged) {
    return {
        today: "2026-08-31",
        events: merged.events,
        counters: merged.counters,
        fortressRev: merged.fortressRev,
        authored: null,
        stats: merged.stats,
        dayLog: merged.dayLog,
        fortress: merged.fortress,
        seal: merged.seal,
        sealAttempts: merged.sealAttempts,
        escalation: merged.escalation,
        tempUnlocks: merged.tempUnlocks
    };
}

// ---- Report ---------------------------------------------------------------
//
// The harness awaits each case, so the report waits for the queue to drain even
// though nothing here is actually asynchronous.

Promise.resolve().then(() => process.exit(report("sync") ? 1 : 0));
