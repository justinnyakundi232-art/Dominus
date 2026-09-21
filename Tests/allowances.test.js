// Tests/allowances.test.js — so many minutes a day, and no more.
//
//     node Tests/allowances.test.js
//
// Two new things had to hold without bending the rules everything else keeps:
//
//   - An allowance merges strengthen-wins. Smaller is stronger, 0 (blocked) is
//     strongest, and raising one needs an authored record carrying the value.
//
//   - Time spent is shared across devices without ever being counted twice.
//     One usage event per device, program and day, merged by the larger total.
//
// See "Daily allowances" in desktop/APP-LIMITS.md.

const { loadSharedLayer, createHarness } = require("./load");

const S = loadSharedLayer().api;
const { describe, it, eq, ok, report } = createHarness();

function app(exe, overrides) {
    return Object.assign({
        id: "app:" + exe, exe: exe, name: exe,
        enabled: true, permanent: false, allowanceMinutes: 0, warnMinutes: 5
    }, overrides || {});
}

function fortress(applications) {
    return { categories: [], manualSites: [], task: null, cooldown: null, applications: applications };
}

async function run() {
    describe("Reading an allowance");

    await it("reads a program with no allowance as blocked outright", async () => {
        // Every entry written before allowances existed. Its meaning must not change.
        const entry = S.normalizeApplication({ exe: "steam.exe", enabled: true });
        eq(entry.allowanceMinutes, 0);
        eq(entry.warnMinutes, 5);
    });

    await it("clamps to whole minutes within a day, and reads nonsense as blocked", async () => {
        eq(S.normalizeApplication(app("a.exe", { allowanceMinutes: 44.6 })).allowanceMinutes, 45);
        eq(S.normalizeApplication(app("a.exe", { allowanceMinutes: 99999 })).allowanceMinutes, 1440);
        eq(S.normalizeApplication(app("a.exe", { allowanceMinutes: -5 })).allowanceMinutes, 0);
        eq(S.normalizeApplication(app("a.exe", { allowanceMinutes: "lots" })).allowanceMinutes, 0);
        eq(S.normalizeApplication(app("a.exe", { warnMinutes: 500 })).warnMinutes, 60);
    });

    await it("keeps blocked programs and allowed ones apart for the watcher", async () => {
        const list = [
            app("notepad.exe"),
            app("steam.exe", { allowanceMinutes: 60, warnMinutes: 10 }),
            app("discord.exe", { allowanceMinutes: 30, enabled: false })
        ];
        eq(S.blockedExecutables(list), ["notepad.exe"]);
        eq(S.allowancesFor(list), { "steam.exe": { allowance_secs: 3600, warn_secs: 600 } });
    });

    await it("never sets a warning at or past the allowance itself", async () => {
        const allowances = S.allowancesFor([app("a.exe", { allowanceMinutes: 3, warnMinutes: 10 })]);
        eq(allowances["a.exe"].warn_secs, 120, "a warning arrived with the gate");
        eq(S.allowancesFor([app("b.exe", { allowanceMinutes: 1, warnMinutes: 5 })])["b.exe"].warn_secs, 0);
    });

    await it("says an allowance the way a person would", async () => {
        eq(S.formatAllowance(45), "45 min");
        eq(S.formatAllowance(60), "1 h");
        eq(S.formatAllowance(90), "1 h 30 min");
    });

    describe("Merging an allowance");

    await it("takes the smaller, with blocked beating any amount", async () => {
        eq(S.mergeApplication(app("s.exe", { allowanceMinutes: 60 }), app("s.exe", { allowanceMinutes: 30 }), 1, 1).allowanceMinutes, 30);
        eq(S.mergeApplication(app("s.exe", { allowanceMinutes: 60 }), app("s.exe"), 1, 1).allowanceMinutes, 0);
    });

    await it("lets the newer commit set the warning", async () => {
        eq(S.mergeApplication(app("s.exe", { warnMinutes: 2 }), app("s.exe", { warnMinutes: 9 }), 1, 5).warnMinutes, 9);
    });

    await it("does not drift when a settled list is merged again", async () => {
        const settled = [app("s.exe", { allowanceMinutes: 45, warnMinutes: 3 })];
        const once = S.mergeApplications(settled, settled, 2, 2);
        eq(S.mergeApplications(once, once, 2, 2), once);
    });

    describe("Raising an allowance");

    await it("is a weakening, and the record carries the new value", async () => {
        const r = S.describeAuthoredWeakening(
            fortress([app("s.exe", { allowanceMinutes: 30 }), app("n.exe")]),
            fortress([app("s.exe", { allowanceMinutes: 60 }), app("n.exe", { allowanceMinutes: 15 })])
        );
        ok(r, "more time produced no record");
        eq(r.allowancesRaised, { "app:s.exe": 60, "app:n.exe": 15 });
    });

    await it("lowering one, or adding a program with time already set, is not", async () => {
        eq(S.describeAuthoredWeakening(
            fortress([app("s.exe", { allowanceMinutes: 60 })]),
            fortress([app("s.exe", { allowanceMinutes: 20 }), app("new.exe", { allowanceMinutes: 90 })])
        ), null);
    });

    await it("crosses to the other peer and lands", async () => {
        const before = fortress([app("s.exe", { allowanceMinutes: 30 })]);
        const after = fortress([app("s.exe", { allowanceMinutes: 60 })]);
        const record = Object.assign({ rev: 2, at: 0, device: "app" }, S.describeAuthoredWeakening(before, after));

        // Without the record, the merge keeps the smaller — the raise is lost.
        eq(S.mergeFortress(before, after, 1, 2, null, null).applications[0].allowanceMinutes, 30);
        // With it, the raise lands.
        eq(S.mergeFortress(before, after, 1, 2, null, [record]).applications[0].allowanceMinutes, 60);
    });

    await it("yields to an allowance made stricter afterwards", async () => {
        // The device raised it to 60, then thought better of it and set 20.
        const record = Object.assign({ rev: 2, at: 0, device: "app" },
            { allowancesRaised: { "app:s.exe": 60 } });
        const holder = fortress([app("s.exe", { allowanceMinutes: 20 })]);
        const other = fortress([app("s.exe", { allowanceMinutes: 30 })]);

        eq(S.mergeFortress(other, holder, 1, 3, null, [record]).applications[0].allowanceMinutes, 20,
            "a superseded raise replayed");
    });

    await it("reads a record written before allowances as raising nothing", async () => {
        eq(S.normalizeAuthored({ rev: 1, at: 1, device: "d", taskCleared: true }).allowancesRaised, {});
        eq(S.normalizeAuthored({ rev: 1, at: 1, device: "d", allowancesRaised: { "app:x.exe": "soon", "app:y.exe": 0 } })
            .allowancesRaised, {}, "a record that cannot say what was chosen chose something");
    });

    describe("A peer that cannot say");

    // What a build from before allowances sends: the whole list rewritten
    // through a normaliser that has never heard of the field. This is not a
    // hypothetical — it is what a 1.11 desktop app does to every entry the
    // moment the user touches any program in its window, and reading it as a
    // list of zeroes is what wiped a real fortress's limits once a minute.
    function silent(exe, overrides) {
        const entry = app(exe, overrides);
        delete entry.allowanceMinutes;
        delete entry.warnMinutes;
        return entry;
    }

    await it("tells silence apart from a zero", async () => {
        ok(S.carriesAllowance(app("s.exe")), "an explicit block was read as silence");
        ok(!S.carriesAllowance(silent("s.exe")), "silence was read as an answer");
        ok(!S.carriesAllowance(null));
    });

    await it("does not let a silent peer block what we allow", async () => {
        const merged = S.mergeApplications(
            [app("s.exe", { allowanceMinutes: 30, warnMinutes: 7 })],
            [silent("s.exe")],
            1, 9
        );
        eq(merged[0].allowanceMinutes, 30, "a peer that cannot speak took the allowance away");
        eq(merged[0].warnMinutes, 7, "a peer that cannot speak reset the reminder");
    });

    await it("still lets a peer that CAN speak block it", async () => {
        // The guard must not become a way to ignore a real decision.
        eq(S.mergeApplications(
            [app("s.exe", { allowanceMinutes: 30 })],
            [app("s.exe", { allowanceMinutes: 0 })],
            1, 9
        )[0].allowanceMinutes, 0, "a deliberate block was ignored");
    });

    await it("blocks a program only the silent peer has", async () => {
        // Nothing held to fill it from, and a peer that can only block meant to.
        const merged = S.mergeApplications([], [silent("n.exe")], 1, 9);
        eq(merged.length, 1);
        eq(merged[0].allowanceMinutes, 0);
    });

    await it("never fills OUR silence from a peer", async () => {
        // Our own silent entry is a 1.11 fortress on first read, where blocked
        // outright is the true meaning. Filling it in would unblock something
        // nobody unblocked.
        eq(S.mergeApplications([silent("s.exe")], [app("s.exe", { allowanceMinutes: 60 })], 9, 1)[0]
            .allowanceMinutes, 0, "a program was quietly unblocked");
    });

    await it("does not drift when the same silent peer speaks again", async () => {
        const held = [app("s.exe", { allowanceMinutes: 30, warnMinutes: 7 })];
        const once = S.mergeApplications(held, [silent("s.exe")], 1, 9);
        eq(S.mergeApplications(once, [silent("s.exe")], 1, 9), once, "the tick runs forever");
    });

    await it("keeps a raise alive that a silent holder would have retired", async () => {
        // The exact failure: the record says 60, the holder's stripped entry
        // reads as 0, 0 is stricter, and rule 4 retires the record for good.
        const record = Object.assign({ rev: 2, at: 0, device: "browser" },
            { allowancesRaised: { "app:s.exe": 60 } });

        // The peer raised it to 60 and wrote the record. We have not adopted
        // the new value yet — only the record has crossed — and by the time it
        // reaches us the peer has stripped its own field on the way past. Its
        // silence must not read as the peer thinking better of the raise.
        const mine = fortress([app("s.exe", { allowanceMinutes: 30 })]);
        const theirs = fortress([silent("s.exe")]);

        eq(S.mergeFortress(mine, theirs, 3, 4, null, [record]).applications[0].allowanceMinutes, 60,
            "a raise was retired by a peer that never disagreed with it");
    });

    await it("still retires a raise a holder really did make stricter", async () => {
        const record = Object.assign({ rev: 2, at: 0, device: "browser" },
            { allowancesRaised: { "app:s.exe": 60 } });

        const mine = fortress([app("s.exe", { allowanceMinutes: 60 })]);
        const theirs = fortress([app("s.exe", { allowanceMinutes: 20 })]);

        eq(S.mergeFortress(mine, theirs, 3, 4, [record], [record]).applications[0].allowanceMinutes, 20,
            "rule 4 was broken to fix rule 3");
    });

    describe("What the seal says");

    await it("names the program and both amounts", async () => {
        const scope = loadSharedLayer().scope;
        const lines = [];
        scope.describeApplicationChanges(
            [app("s.exe", { name: "Steam", allowanceMinutes: 30 }), app("n.exe", { name: "Notepad" })],
            [app("s.exe", { name: "Steam", allowanceMinutes: 90 }), app("n.exe", { name: "Notepad", allowanceMinutes: 10 })],
            lines
        );
        eq(lines, [
            "Steam's allowance raised from 30 min to 1 h 30 min a day.",
            "Notepad gets 10 min a day — it was blocked outright."
        ]);
    });

    describe("Spending");

    await it("keeps one running total per device, program and day", async () => {
        let log = [];
        log = S.addUsage(log, "pc", "Steam.exe", "2026-09-17", 60, 1000);
        log = S.addUsage(log, "pc", "steam.exe", "2026-09-17", 45, 2000);
        eq(log.length, 1, "a second minute became a second event");
        eq(log[0].id, "usage:pc:steam.exe:2026-09-17");
        eq(log[0].seconds, 105);
    });

    await it("does not touch the log it was handed", async () => {
        const log = S.addUsage([], "pc", "steam.exe", "2026-09-17", 60, 1);
        const snapshot = JSON.stringify(log);
        S.addUsage(log, "pc", "steam.exe", "2026-09-17", 60, 2);
        eq(JSON.stringify(log), snapshot);
    });

    await it("sums across devices, and only for the day asked", async () => {
        let log = [];
        log = S.addUsage(log, "pc", "steam.exe", "2026-09-17", 600, 1);
        log = S.addUsage(log, "laptop", "steam.exe", "2026-09-17", 300, 2);
        log = S.addUsage(log, "pc", "steam.exe", "2026-09-16", 9999, 3);
        log = S.addUsage(log, "pc", "discord.exe", "2026-09-17", 30, 4);
        eq(S.deriveUsage(log, "2026-09-17"), { "steam.exe": 900, "discord.exe": 30 });
    });

    await it("merges two copies of one total by the larger, and never double-counts", async () => {
        // The app has counted further than the extension last heard.
        const behind = S.addUsage([], "pc", "steam.exe", "2026-09-17", 300, 1);
        const ahead = S.addUsage(behind, "pc", "steam.exe", "2026-09-17", 200, 2);

        const once = S.mergeEventLogs(behind, ahead, "2026-09-17");
        eq(S.deriveUsage(once, "2026-09-17")["steam.exe"], 500);
        eq(S.deriveUsage(S.mergeEventLogs(ahead, behind, "2026-09-17"), "2026-09-17")["steam.exe"], 500,
            "the older copy won when it was on the other side");

        // Merged again and again, as the tick does forever.
        const twice = S.mergeEventLogs(once, once, "2026-09-17");
        eq(S.deriveUsage(twice, "2026-09-17")["steam.exe"], 500, "repeated syncs inflated the total");
    });

    await it("leaves the day log and the counters alone", async () => {
        // Using an allowance is not a stand or a slip.
        const log = S.addUsage([], "pc", "steam.exe", "2026-09-17", 3600, 1);
        eq(S.deriveDayLog(log), {});
    });

    await it("drops a usage event that names no program", async () => {
        const merged = S.mergeEventLogs([{ id: "usage:pc::2026-09-17", type: "usage", device: "pc", date: "2026-09-17", seconds: 50 }], [], "2026-09-17");
        eq(merged, []);
    });

    describe("What the watcher is told");

    await it("carries blocks, allowances, today's spend and live unlocks", async () => {
        const state = {
            fortress: fortress([
                app("notepad.exe"),
                app("steam.exe", { allowanceMinutes: 60, warnMinutes: 5 }),
                app("discord.exe", { allowanceMinutes: 30, enabled: false })
            ]),
            tempUnlocks: { "steam.exe": Date.now() + 60000, "notepad.exe": Date.now() - 1, "youtube.com": Date.now() + 60000 },
            events: S.addUsage(S.addUsage([], "pc", "steam.exe", "2026-09-17", 600, 1), "pc", "steam.exe", "2026-09-16", 999, 2)
        };
        const told = S.enforcementFor(state, "2026-09-17");

        eq(told.blocked, ["notepad.exe"]);
        eq(told.allowances, { "steam.exe": { allowance_secs: 3600, warn_secs: 300 } });
        eq(told.spent, { "steam.exe": 600 }, "yesterday's time, or another program's, was counted");
        eq(Object.keys(told.unlocked_until), ["steam.exe"], "an expired or unrelated unlock was sent");
        eq(told.day, "2026-09-17");
    });

    describe("The whole trip");

    await it("time spent in the app reaches the extension through a real merge", async () => {
        const L = loadSharedLayer();
        const peer = (events) => ({
            today: "2026-09-17", events: events, counters: {}, fortressRev: 1, authored: [],
            stats: { dayLogSeeded: true }, dayLog: {},
            fortress: fortress([app("steam.exe", { allowanceMinutes: 60 })]),
            seal: { enabled: false }, sealAttempts: { failures: 0, lockedUntil: 0 },
            escalation: {}, tempUnlocks: {}
        });

        const ext = peer(S.addUsage([], "app-device", "steam.exe", "2026-09-17", 600, 1));
        const desk = peer(S.addUsage(ext.events, "app-device", "steam.exe", "2026-09-17", 900, 2));

        const merged = L.api.mergePeerState(ext, desk, Date.now());
        eq(L.api.deriveUsage(merged.events, "2026-09-17")["steam.exe"], 1500);
        eq(merged.fortress.applications[0].allowanceMinutes, 60);

        const again = L.api.mergePeerState(merged, desk, Date.now());
        eq(L.api.deriveUsage(again.events, "2026-09-17")["steam.exe"], 1500);
    });

    return report("allowances");
}

run().then((code) => process.exit(code));
