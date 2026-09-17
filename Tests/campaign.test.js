// Tests/campaign.test.js — what The Campaign draws, from state already in hand.
//
//     node Tests/campaign.test.js
//
// The desktop app has no chrome.storage. It draws The Campaign from the state
// the extension synced to it, using the extension's own code — so the two pure
// functions that make that possible, buildDayHistory() and standingFrom(), are
// the ones checked here. getDayHistory() is now a storage wrapper around the
// first, so this also covers what the extension shows.

const { loadSharedLayer, createHarness } = require("./load");

const { describe, it, eq, ok, report } = createHarness();
const scope = loadSharedLayer().scope;

async function run() {
    describe("The history grid");

    await it("covers exactly the days asked for, oldest first, ending today", async () => {
        const history = scope.buildDayHistory({}, { historyStartedOn: "2026-09-01" }, 7, "2026-09-17");
        eq(history.map((d) => d.date), [
            "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14",
            "2026-09-15", "2026-09-16", "2026-09-17"
        ]);
    });

    await it("draws each state from the day log", async () => {
        const log = {
            "2026-09-14": { stands: 4, unlocks: 0 },
            "2026-09-15": { stands: 1, unlocks: 2, sites: { "youtube.com": 1, "notepad.exe": 1 }, firstSlip: "23:10" },
            "2026-09-16": { stands: 0, unlocks: 0, inferred: true }
        };
        const history = scope.buildDayHistory(log, { historyStartedOn: "2026-09-13" }, 5, "2026-09-17");

        eq(history.map((d) => d.state), ["untested", "held", "slipped", "inferred", "untested"]);
        eq(history[2].entry.sites, { "youtube.com": 1, "notepad.exe": 1 });
        eq(history[2].entry.firstSlip, "23:10");
    });

    await it("marks days before the record began as no record, not untested", async () => {
        // "Untested" claims you were here and nothing tested you. Before the
        // history starts, Dominus cannot say that.
        const history = scope.buildDayHistory({}, { historyStartedOn: "2026-09-16" }, 4, "2026-09-17");
        eq(history.map((d) => d.state), ["before", "before", "untested", "untested"]);
    });

    await it("ignores a log entry dated before the record began", async () => {
        const log = { "2026-09-14": { stands: 9, unlocks: 0 } };
        const history = scope.buildDayHistory(log, { historyStartedOn: "2026-09-16" }, 4, "2026-09-17");
        eq(history[0].state, "before");
        eq(history[0].entry, null);
    });

    await it("falls back to the oldest logged day when the start was never stamped", async () => {
        const log = { "2026-09-15": { stands: 1, unlocks: 0 } };
        const history = scope.buildDayHistory(log, {}, 4, "2026-09-17");
        eq(history.map((d) => d.state), ["before", "held", "untested", "untested"]);
    });

    await it("does not touch the log it was handed", async () => {
        // The desktop hands in the synced state itself. Drawing must not edit it.
        const log = { "2026-09-15": { stands: 1, unlocks: 0 } };
        const before = JSON.stringify(log);
        scope.buildDayHistory(log, { historyStartedOn: "2026-09-10" }, 7, "2026-09-17");
        eq(JSON.stringify(log), before);
    });

    describe("Where the fortress stands");

    await it("brings the streak current, so quiet days since the last sync still count", async () => {
        // The extension last wrote on the 14th. Three clean days have passed
        // since — the browser may simply have been closed.
        const stats = { currentStreak: 5, longestStreak: 5, lastCleanDate: "2026-09-14", lastUnlockDate: "2026-09-08" };
        const standing = scope.standingFrom(stats, {}, "2026-09-17");
        eq(standing.currentStreak, 8);
        eq(standing.longestStreak, 8);
    });

    await it("does not count today when today already slipped", async () => {
        const stats = { currentStreak: 5, longestStreak: 9, lastCleanDate: "2026-09-16", lastUnlockDate: "2026-09-17" };
        eq(scope.standingFrom(stats, {}, "2026-09-17").currentStreak, 5);
    });

    await it("leaves the stats it was handed alone", async () => {
        const stats = { currentStreak: 5, lastCleanDate: "2026-09-14" };
        scope.standingFrom(stats, {}, "2026-09-17");
        eq(stats.currentStreak, 5, "the synced state was edited while being read");
    });

    await it("takes the victory rate from every device's counters", async () => {
        const counters = { chrome: { stands: 200, unlocks: 30 }, desktop: { stands: 20, unlocks: 6 } };
        const standing = scope.standingFrom({ stayFocusedCount: 1, unlockCount: 1 }, counters, "2026-09-17");
        eq(standing.stayFocusedCount, 220);
        eq(standing.unlockCount, 36);
        eq(Math.round(standing.ratio * 100), 86);
    });

    await it("falls back to the stats totals for a peer with no counters", async () => {
        const standing = scope.standingFrom({ stayFocusedCount: 3, unlockCount: 1 }, {}, "2026-09-17");
        eq(standing.ratio, 0.75);
    });

    await it("says there is no rate yet rather than a rate of zero", async () => {
        eq(scope.standingFrom({}, {}, "2026-09-17").ratio, null);
    });

    await it("agrees with getStats() on the same data", async () => {
        // The extension draws from getStats(); the app draws from standingFrom().
        // Given the same fortress they must show the same figures.
        const L = loadSharedLayer();
        const stats = {
            currentStreak: 2, longestStreak: 7, lastCleanDate: L.scope.todayLocal(),
            lastUnlockDate: "2026-01-01", stayFocusedCount: 12, unlockCount: 4,
            currentResistance: 3, longestResistance: 11
        };
        L.store.stats = JSON.parse(JSON.stringify(stats));

        const fromStorage = await L.scope.getStats();
        const inHand = L.scope.standingFrom(stats, {}, L.scope.todayLocal());

        ["currentStreak", "longestStreak", "currentResistance", "longestResistance", "ratio"]
            .forEach((key) => eq(inHand[key], fromStorage[key], key + " disagreed"));
        ok(inHand.ratio === 0.75);
    });

    return report("campaign");
}

run().then((code) => process.exit(code));
