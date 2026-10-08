// Tests/bridge.test.js — the extension's scripts, as the phone runs them.
//
//     node Tests/bridge.test.js
//
// The iOS app does not copy the rules; it loads ios/Bridge.js and then the
// extension's shared layer exactly as it is, through JavaScriptCore.
// Bridge.js supplies what a phone lacks — crypto, chrome.storage.local, and a
// clock that can be held — and a handful of native hooks stand behind it.
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

// The order SharedRules.swift loads them in: the bridge, then the same set, in
// the same order, as Tests/load.js and the extension's service worker.
const FILES = ["ios/Bridge.js", "Tasks.js", "Categories.js", "Applications.js", "Stats.js", "Seal.js", "Sync.js", "TrackProgress.js"];

function loadPhone() {
    const root = path.join(__dirname, "..");
    const store = {};

    const scope = vm.createContext({
        __dominusRandomUInt32: () => nodeCrypto.randomBytes(4).readUInt32BE(0),
        __dominusUUID: () => nodeCrypto.randomUUID(),
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
        write: (key, value) => { store[key] = JSON.stringify(value); },
        run: (source) => vm.runInContext(source, scope),
        // The four calls Swift makes about the fortress, with the JSON text
        // handled the way Swift handles it.
        fortress: async () => JSON.parse(await scope.__dominusFortress()),
        review: async (next) => JSON.parse(await scope.__dominusReview(JSON.stringify(next))).weakenings,
        reviewWhole: async (next) => JSON.parse(await scope.__dominusReview(JSON.stringify(next))),
        commit: async (next) => JSON.parse(await scope.__dominusCommit(JSON.stringify(next))),
        standards: async (domain) => JSON.parse(await scope.__dominusStandards(domain)),
        campaign: async () => JSON.parse(await scope.__dominusCampaign())
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

    describe("The fortress");

    await it("a new fortress has the extension's categories, all switched off", async () => {
        const phone = loadPhone();

        const fortress = await phone.fortress();

        eq(fortress.categories.map((c) => c.name), ["Social Media", "Video Streaming", "Gaming"]);
        eq(fortress.categories.some((c) => c.enabled), false);
        eq(fortress.blockedSites, []);
        eq(fortress.task, null);
        eq(fortress.cooldown, { seconds: 60, escalate: false, factor: 1.25 });
        eq(fortress.removeCooldownSeconds, 10);
    });

    await it("sites typed in the test builds become sites blocked by hand", async () => {
        const phone = loadPhone();
        // What the app does before its first read: the old list is put where
        // the extension's own migration looks for one.
        phone.write("blockedSites", ["reddit.com", "youtube.com"]);

        const fortress = await phone.fortress();

        eq(fortress.manualSites, ["reddit.com", "youtube.com"]);
        eq(fortress.blockedSites.sort(), ["reddit.com", "youtube.com"]);
    });

    await it("switching a category on is free, and blocks its sites", async () => {
        const phone = loadPhone();
        const fortress = await phone.fortress();
        fortress.categories[1].enabled = true;

        eq(await phone.review({ categories: fortress.categories }), []);
        const result = await phone.commit({ categories: fortress.categories });

        ok(result.blockedSites.includes("youtube.com"), "its sites were not blocked");
        ok(phone.read("blockedSites").includes("netflix.com"), "the stored block list was not re-derived");
    });

    await it("switching it off again is named as a weakening, in the extension's words", async () => {
        const phone = loadPhone();
        const fortress = await phone.fortress();
        fortress.categories[1].enabled = true;
        await phone.commit({ categories: fortress.categories });

        const after = await phone.fortress();
        after.categories[1].enabled = false;

        eq(await phone.review({ categories: after.categories }),
            ["Video Streaming switched off — 5 sites stop being blocked."]);
    });

    await it("taking one site out of a category names the site", async () => {
        const phone = loadPhone();
        const fortress = await phone.fortress();
        fortress.categories[1].enabled = true;
        await phone.commit({ categories: fortress.categories });

        const after = await phone.fortress();
        after.categories[1].sites = after.categories[1].sites.filter((site) => site !== "hulu.com");

        eq(await phone.review({ categories: after.categories }), ["hulu.com removed from Video Streaming."]);
    });

    await it("a site typed with a scheme is stored as a bare domain", async () => {
        const phone = loadPhone();

        const result = await phone.commit({ manualSites: ["https://www.Example.com/path", "example.com"] });

        eq(result.blockedSites, ["example.com"]);
        eq((await phone.fortress()).manualSites, ["example.com"]);
    });

    await it("unblocking a site blocked by hand is a weakening", async () => {
        const phone = loadPhone();
        await phone.commit({ manualSites: ["example.com"] });

        eq(await phone.review({ manualSites: [] }), ["example.com unblocked."]);
    });

    await it("a new category gets an id and a banner of its own", async () => {
        const phone = loadPhone();
        const fortress = await phone.fortress();
        fortress.categories.push({ name: "News", sites: ["bbc.co.uk"], enabled: true });

        await phone.commit({ categories: fortress.categories });

        const made = (await phone.fortress()).categories[3];
        ok(made.id && made.id.startsWith("custom-"), "no id was minted");
        ok(made.color && made.glyph, "no banner was given");
        eq(made.sites, ["bbc.co.uk"]);
    });

    await it("an unknown field on a category survives a round trip", async () => {
        const phone = loadPhone();
        const fortress = await phone.fortress();
        // A category's own task: nothing on the phone edits it yet, so it must
        // come back exactly as it went rather than being dropped.
        fortress.categories[0].task = { type: "passage" };
        await phone.commit({ categories: fortress.categories });

        const again = await phone.fortress();
        again.categories[0].enabled = true;
        await phone.commit({ categories: again.categories });

        eq((await phone.fortress()).categories[0].task, { type: "passage" });
    });

    describe("Standards");

    await it("setting a task is free; clearing it is not", async () => {
        const phone = loadPhone();

        eq(await phone.review({ task: { type: "passage" } }), []);
        await phone.commit({ task: { type: "passage" } });
        eq((await phone.fortress()).task, { type: "passage" });

        const lines = await phone.review({ task: null });
        eq(lines.length, 1, "clearing the task was not named");
    });

    await it("swapping one task for another waits, but is a change and not a taking down", async () => {
        const phone = loadPhone();
        await phone.commit({ task: { type: "code", code: "ABCD2345" } });

        const swap = await phone.reviewWhole({ task: { type: "passage" } });

        eq(swap.weakenings, ["Fortress-wide task changed from Guarded Code to Random Passage."]);
        eq(swap.changeOnly, true);
    });

    await it("clearing the task, or swapping it while something else comes down, is a taking down", async () => {
        const phone = loadPhone();
        const fortress = await phone.fortress();
        fortress.categories[0].enabled = true;
        await phone.commit({ categories: fortress.categories, task: { type: "code", code: "ABCD2345" } });

        eq((await phone.reviewWhole({ task: null })).changeOnly, false);

        const after = await phone.fortress();
        after.categories[0].enabled = false;
        const both = await phone.reviewWhole({ categories: after.categories, task: { type: "passage" } });

        eq(both.weakenings.length, 2);
        eq(both.changeOnly, false);
    });

    await it("an edit that says nothing about the task leaves it alone", async () => {
        const phone = loadPhone();
        await phone.commit({ task: { type: "cooldown", message: "Is this worth it?" } });

        await phone.commit({ manualSites: ["example.com"] });

        eq((await phone.fortress()).task, { type: "cooldown", message: "Is this worth it?" });
    });

    await it("a longer cooldown is free; a shorter one is not", async () => {
        const phone = loadPhone();

        eq(await phone.review({ cooldown: { seconds: 300, escalate: true, factor: 1.5 } }), []);
        await phone.commit({ cooldown: { seconds: 300, escalate: true, factor: 1.5 } });

        const lines = await phone.review({ cooldown: { seconds: 120, escalate: true, factor: 1.5 } });
        eq(lines.length, 1, "shortening the cooldown was not named");
    });

    await it("an unlock is governed by the fortress's task and cooldown", async () => {
        const phone = loadPhone();
        await phone.commit({
            task: { type: "code", code: "ABCD2345" },
            cooldown: { seconds: 120, escalate: false, factor: 1.25 }
        });

        const forApp = await phone.standards(null);
        const forSite = await phone.standards("youtube.com");

        eq(forApp.task, { type: "code", code: "ABCD2345" });
        eq(forApp.cooldown.seconds, 120);
        eq(forSite.task, forApp.task);
        eq(forSite.permanent, false);
    });

    describe("What a peer will be told");

    await it("a commit raises the revision, and a weakening leaves a record", async () => {
        const phone = loadPhone();
        const fortress = await phone.fortress();
        fortress.categories[0].enabled = true;
        await phone.commit({ categories: fortress.categories });

        const after = await phone.fortress();
        after.categories[0].enabled = false;
        await phone.commit({ categories: after.categories });

        const meta = phone.read("syncMeta");
        eq(meta.fortressRev, 2);
        eq(meta.authored.length, 1);
        eq(meta.authored[0].categoriesDisabled, ["socialMedia"]);
    });

    await it("a stand replayed from yesterday is logged as yesterday's event", async () => {
        const phone = loadPhone();
        const yesterday = daysAgo(1, 12, 0);

        await phone.scope.__dominusRecord([{ type: "stand", at: yesterday.getTime() }]);
        // The mirror into the event log is deliberately not awaited by Stats.js.
        await tick();
        await tick();

        const events = phone.read("syncEvents");
        eq(events.length, 1);
        eq(events[0].type, "stand");
        eq(events[0].at, yesterday.getTime());
        eq(events[0].date, phone.scope.localDateString(yesterday));
    });

    describe("The Campaign");

    await it("is twenty-six weeks ending today, laid out as the extension lays it out", async () => {
        const phone = loadPhone();

        const campaign = await phone.campaign();
        const first = campaign.days[0];
        const last = campaign.days[campaign.days.length - 1];

        eq(campaign.weeks, 26);
        eq(campaign.days.length, 182);
        eq(last.date, phone.scope.todayLocal());
        eq(last.today, true);
        eq(campaign.days.filter((day) => day.today).length, 1);
        // The first column starts on a Sunday, so the first day is pushed down
        // by as many squares as its weekday.
        eq(campaign.blanks, phone.scope.dateFromLocalString(first.date).getDay());
        eq(campaign.months.length, Math.ceil((182 + campaign.blanks) / 7));
        eq(campaign.months[0], "", "a month was named over the first, partial column");
        eq(campaign.weekdays, ["", "Mon", "", "Wed", "", "Fri", ""]);
    });

    await it("a new fortress has no history to claim", async () => {
        const phone = loadPhone();

        const campaign = await phone.campaign();

        eq(campaign.summary.recorded, 0);
        eq(campaign.days[0].state, "before");
        eq(campaign.days[0].description, "This is before your history begins.");
        eq(campaign.days[181].state, "untested");
        eq(campaign.standing.ratio, null);
    });

    await it("each day arrives described and shaded by TrackProgress.js", async () => {
        const phone = loadPhone();
        const twoAgo = daysAgo(2, 23, 14);
        const yesterday = daysAgo(1, 12, 0);

        await phone.scope.__dominusRecord([
            { type: "stand", at: twoAgo.getTime() - 60000 },
            { type: "slip", at: twoAgo.getTime(), domain: "youtube.com" },
            { type: "stand", at: yesterday.getTime() },
            { type: "stand", at: yesterday.getTime() + 1000 },
            { type: "stand", at: yesterday.getTime() + 2000 }
        ]);

        const campaign = await phone.campaign();
        const slipped = campaign.days[179];
        const held = campaign.days[180];

        eq(slipped.state, "slipped");
        eq(slipped.stateLabel, "Slipped");
        eq(slipped.level, 1);
        eq(slipped.description, "1 stand, then youtube.com at 23:14.");
        eq(slipped.label, phone.scope.formatDayLabel(phone.scope.localDateString(twoAgo)));

        eq(held.state, "held");
        eq(held.level, 2, "three stands is the second shade");
        eq(held.description, "3 stands, no unlocks.");

        eq(campaign.summary.held, 1);
        eq(campaign.summary.slipped, 1);
        eq(campaign.summary.recorded, 2);
        ok(campaign.summary.span.startsWith("Since "), "the span was not named by when the record starts");
    });

    await it("a day with several unlocks says how many before it says whose", async () => {
        const phone = loadPhone();
        const describe = (entry) => phone.scope.describeDay({ state: "slipped", entry });

        // The day this wording was changed for: read on a phone as the same
        // two unlocks stated twice. Two of x.com and two apps, which iOS
        // gives no name for.
        eq(describe({ stands: 8, unlocks: 4, sites: { "x.com": 2 }, firstSlip: "07:48" }),
            "8 stands, then 4 unlocks: x.com twice and 2 others. First at 07:48.");

        // Three sites tied at one each: the first is named, and the other two
        // are still counted rather than lost.
        eq(describe({ stands: 0, unlocks: 3, sites: { "x.com": 1, "reddit.com": 1, "youtube.com": 1 }, firstSlip: "09:00" }),
            "3 unlocks: x.com and 2 others. First at 09:00.");
        eq(describe({ stands: 0, unlocks: 2, sites: { "x.com": 1 }, firstSlip: "09:00" }),
            "2 unlocks: x.com and 1 other. First at 09:00.");
        eq(describe({ stands: 1, unlocks: 3, sites: { "x.com": 3 }, firstSlip: "22:10" }),
            "1 stand, then x.com 3 times. First at 22:10.");
        eq(describe({ stands: 0, unlocks: 3, sites: {}, firstSlip: "22:10" }),
            "3 unlocks. First at 22:10.");
    });

    await it("a day with one unlock stays as short as it was", async () => {
        const phone = loadPhone();
        const describe = (entry) => phone.scope.describeDay({ state: "slipped", entry });

        eq(describe({ stands: 2, unlocks: 1, sites: { "youtube.com": 1 }, firstSlip: "23:14" }),
            "2 stands, then youtube.com at 23:14.");
        eq(describe({ stands: 0, unlocks: 1, sites: {}, firstSlip: "23:14" }), "one unlock at 23:14.");
        eq(describe({ stands: 0, unlocks: 1, sites: {}, firstSlip: null }), "one unlock.");
    });

    process.exit(report("bridge") ? 1 : 0);
}

run();
