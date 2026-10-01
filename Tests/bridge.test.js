// Tests/bridge.test.js — the extension's scripts, as the phone runs them.
//
//     node Tests/bridge.test.js
//
// The iOS app does not copy the rules; it loads ios/Bridge.js and then
// Categories.js, Tasks.js and Stats.js exactly as they are, through
// JavaScriptCore. Bridge.js supplies what a phone lacks — crypto,
// chrome.storage.local, and a clock that can be held — and three native hooks
// stand behind it.
//
// This loads the same files in the same order with those hooks faked, so the
// part that cannot be compiled on Windows is at least run somewhere before it
// reaches a phone. What it cannot show is JavaScriptCore's own timing: there,
// the promise chain has settled by the time Swift's call returns. Here it is
// awaited.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const nodeCrypto = require("crypto");

const { createHarness } = require("./load.js");

const { describe, it, eq, ok, report } = createHarness();

// The order SharedRules.swift loads them in.
const FILES = ["ios/Bridge.js", "Categories.js", "Tasks.js", "Stats.js"];

function loadPhone() {
    const root = path.join(__dirname, "..");
    const store = {};

    const scope = vm.createContext({
        __dominusRandomUInt32: () => nodeCrypto.randomBytes(4).readUInt32BE(0),
        // JSON strings, one per key, as the App Group holds them.
        __dominusStorageRead: (key) => (key in store ? store[key] : null),
        __dominusStorageWrite: (key, json) => { store[key] = json; }
    });

    FILES.forEach((file) => {
        vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), scope, { filename: file });
    });

    return {
        scope,
        read: (key) => (key in store ? JSON.parse(store[key]) : undefined),
        run: (source) => vm.runInContext(source, scope)
    };
}

function daysAgo(days, hours, minutes) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hours, minutes, 0);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function run() {
    describe("Loading");

    await it("the extension's scripts load beside the bridge and answer", async () => {
        const phone = loadPhone();

        eq(phone.scope.normalizeDomain("https://www.YouTube.com/feed"), "youtube.com");
        eq(phone.scope.generatePassage().split(" ").length, 12, "a passage is twelve words");
        eq(
            [0, 1, 2].map((n) => phone.scope.effectiveCooldownSeconds({ seconds: 60, escalate: true, factor: 1.25 }, n)),
            [60, 75, 94]
        );
    });

    describe("The clock");

    await it("a stand made yesterday is recorded yesterday", async () => {
        const phone = loadPhone();
        const yesterday = daysAgo(1, 12, 0);

        await phone.scope.__dominusRecord([{ type: "stand", at: yesterday.getTime() }]);

        const day = phone.read("dayLog")[phone.scope.localDateString(yesterday)];
        ok(day, "nothing was written against yesterday");
        eq(day.stands, 1);
        eq(phone.read("dayLog")[phone.scope.todayLocal()], undefined, "the stand also landed on today");
    });

    await it("a slip keeps its day, its moment and its time of day", async () => {
        const phone = loadPhone();
        const then = daysAgo(2, 23, 14);

        await phone.scope.__dominusRecord([{ type: "slip", at: then.getTime(), domain: "youtube.com" }]);

        const date = phone.scope.localDateString(then);
        const day = phone.read("dayLog")[date];
        eq(day.unlocks, 1);
        eq(day.sites, { "youtube.com": 1 });
        eq(day.firstSlip, "23:14");
        eq(phone.read("stats").lastUnlockDate, date);
        eq(phone.read("stats").lastUnlockAt, then.getTime());
    });

    await it("an event with no time is recorded now", async () => {
        const phone = loadPhone();

        await phone.scope.__dominusRecord([{ type: "stand" }]);

        eq(phone.read("dayLog")[phone.scope.todayLocal()].stands, 1);
    });

    await it("the clock is let go afterwards, and after a failure too", async () => {
        const phone = loadPhone();

        await phone.scope.__dominusRecord([{ type: "stand", at: daysAgo(3, 9, 0).getTime() }]);
        ok(Math.abs(phone.run("Date.now()") - Date.now()) < 1000, "still held after a replay");

        phone.scope.recordStayFocused = () => Promise.reject(new Error("storage gone"));
        let threw = false;
        try {
            await phone.scope.__dominusRecord([{ type: "stand", at: daysAgo(3, 9, 0).getTime() }]);
        } catch (error) {
            threw = true;
        }
        ok(threw, "the failure was swallowed");
        ok(Math.abs(phone.run("Date.now()") - Date.now()) < 1000, "still held after a failed replay");
    });

    await it("only `now` is held: every other use of Date is the real one", async () => {
        const phone = loadPhone();

        phone.scope.__dominusHoldClock(daysAgo(5, 8, 30).getTime());
        eq(phone.run("new Date(2026, 0, 2).getDate()"), 2);
        eq(phone.run("new Date() instanceof Date"), true);
        eq(phone.run("new Date().getHours()"), 8);
        eq(phone.run("addDaysLocal('2026-03-01', -1)"), "2026-02-28");
        phone.scope.__dominusReleaseClock();
    });

    describe("Standing");

    await it("reads what the extension's Keep reads", async () => {
        const phone = loadPhone();

        await phone.scope.__dominusRecord([
            { type: "slip", at: daysAgo(2, 23, 14).getTime(), domain: "youtube.com" },
            { type: "stand", at: daysAgo(1, 12, 0).getTime() },
            { type: "stand" }
        ]);

        const view = JSON.parse(await phone.scope.__dominusStanding());

        eq(view.todayState, "held");
        eq(view.today.stands, 1);
        eq(view.standing.stayFocusedCount, 2);
        eq(view.standing.unlockCount, 1);
        eq(view.standing.currentResistance, 2);
        // A slip two days ago and nothing since: today is the first clean day
        // counted, exactly as Stats.js counts it in Chrome.
        eq(view.standing.currentStreak, 1);
    });

    await it("a slip today takes today out of the streak", async () => {
        const phone = loadPhone();

        await phone.scope.__dominusRecord([{ type: "stand" }]);
        await phone.scope.__dominusStanding();
        await phone.scope.__dominusRecord([{ type: "slip" }]);

        const view = JSON.parse(await phone.scope.__dominusStanding());

        eq(view.todayState, "slipped");
        eq(view.standing.currentStreak, 0);
        eq(view.standing.currentResistance, 0);
    });

    await it("a fresh fortress is untested, with no rate to show", async () => {
        const phone = loadPhone();

        const view = JSON.parse(await phone.scope.__dominusStanding());

        eq(view.todayState, "untested");
        eq(view.standing.ratio, null);
        eq(view.standing.currentStreak, 1);
    });

    describe("Settling");

    await it("the box Swift reads fills with the value", async () => {
        const phone = loadPhone();

        const box = phone.scope.__dominusSettle(phone.scope.__dominusStanding());
        await tick();

        eq(box.done, true);
        eq(box.error, null);
        eq(typeof box.value, "string");
    });

    await it("and with the reason, when the chain fails", async () => {
        const phone = loadPhone();

        const box = phone.scope.__dominusSettle(Promise.reject(new Error("boom")));
        await tick();

        eq(box.done, true);
        eq(box.error, "boom");
    });

    process.exit(report("bridge") ? 1 : 0);
}

run();
