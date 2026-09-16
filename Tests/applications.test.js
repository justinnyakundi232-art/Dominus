// Tests/applications.test.js — the programs in the fortress.
//
//     node Tests/applications.test.js
//
// Applications are the first thing Dominus blocks that the browser cannot see,
// and the first thing added to the fortress since the merge rules were settled.
// So this suite asks two questions: does the identity rule hold, and did
// applications need a fifth rule for weakenings.
//
// The identity rule is the load-bearing one. An application's id is DERIVED
// from its executable rather than generated, and everything below depends on
// that: two devices that each blocked Steam, with no chance to coordinate, have
// to agree they blocked the same thing. A random id would leave the union
// holding two Steams forever.
//
// The reasoning is in desktop/APP-LIMITS.md.

const { loadSharedLayer, createHarness } = require("./load");

const S = loadSharedLayer().api;
const { describe, it, eq, ok, report } = createHarness();

const clone = (v) => JSON.parse(JSON.stringify(v));

function app(exe, overrides) {
    return Object.assign({
        id: "app:" + exe,
        exe: exe,
        name: exe,
        enabled: true,
        permanent: false
    }, overrides || {});
}

const ids = (list) => (list || []).map((a) => a.id).sort();

// ---- A peer, as authored.test.js builds one -------------------------------

let revClock = 0;

function peer(name, applications) {
    return {
        name: name,
        today: "2026-09-09",
        events: [],
        counters: {},
        fortressRev: 0,
        authored: [],
        stats: { dayLogSeeded: true },
        dayLog: {},
        fortress: {
            categories: [],
            manualSites: [],
            applications: clone(applications || []),
            task: null,
            cooldown: { seconds: 300, escalate: false, factor: 1.25 }
        },
        seal: { enabled: false },
        sealAttempts: { failures: 0, lockedUntil: 0 },
        escalation: {},
        tempUnlocks: {}
    };
}

// What commitFortress does: work out what the edit gave up, stamp a revision,
// and keep the record if it gave up anything.
function commit(p, next) {
    const before = clone(p.fortress);
    const after = Object.assign(clone(p.fortress), next);

    const record = S.describeAuthoredWeakening(before, after);
    p.fortressRev = ++revClock;
    p.fortress = after;

    if (record) {
        p.authored = p.authored.concat([Object.assign({
            rev: p.fortressRev,
            at: Date.now() + p.fortressRev,
            device: p.name
        }, record)]);
    }

    return record;
}

function syncInto(to, from) {
    const merged = S.mergePeerState(to, from, Date.now());
    to.fortress = merged.fortress;
    to.fortressRev = merged.fortressRev;
    to.events = merged.events;
    to.counters = merged.counters;
    to.stats = merged.stats;
    to.dayLog = merged.dayLog;
    to.seal = merged.seal;
    to.sealAttempts = merged.sealAttempts;
    to.authored = merged.authored;
    return to;
}

// ---- Tests ----------------------------------------------------------------

async function run() {
    describe("Identity");

    await it("takes the basename off a path, whatever the separator", async () => {
        eq(S.normalizeExecutable("C:\\Program Files (x86)\\Steam\\steam.exe"), "steam.exe");
        eq(S.normalizeExecutable("/Applications/Steam/steam"), "steam");
        eq(S.normalizeExecutable("steam.exe"), "steam.exe");
    });

    await it("lowercases, because Windows does not care and a set does", async () => {
        eq(S.normalizeExecutable("STEAM.EXE"), "steam.exe");
        eq(S.normalizeExecutable("  Steam.Exe  "), "steam.exe");
    });

    await it("refuses what is not a program name", async () => {
        eq(S.normalizeExecutable(""), "");
        eq(S.normalizeExecutable("   "), "");
        eq(S.normalizeExecutable("C:\\Games\\"), "");
        eq(S.normalizeExecutable("."), "");
        eq(S.normalizeExecutable(".."), "");
        eq(S.normalizeExecutable(null), "");
    });

    await it("gives the same id to the same program on two machines", async () => {
        // The whole point. Different drive, different case, different
        // separator, and neither device ever spoke to the other.
        const windows = S.applicationId("C:\\Program Files (x86)\\Steam\\Steam.exe");
        const elsewhere = S.applicationId("D:\\Games\\steam\\STEAM.EXE");
        eq(windows, elsewhere, "one program got two identities");
        eq(windows, "app:steam.exe");
    });

    await it("guesses a name a person would recognise", async () => {
        eq(S.applicationDisplayName("steam.exe"), "Steam");
        eq(S.applicationDisplayName("vs_code.exe"), "Vs Code");
        eq(S.applicationDisplayName("league of legends.exe"), "League Of Legends");
    });

    describe("What can never be blocked");

    await it("refuses the shell, the exit and the gate itself", async () => {
        // Blocking explorer.exe would minimize the taskbar the moment it was
        // clicked. Blocking Task Manager would remove the way out. Blocking
        // dominus.exe would gate the gate.
        ["explorer.exe", "C:\\Windows\\explorer.exe", "TASKMGR.EXE", "dominus.exe",
         "SystemSettings.exe", "ApplicationFrameHost.exe"].forEach((exe) => {
            eq(S.normalizeApplication({ exe: exe, enabled: true }), null, exe + " got in");
        });
    });

    await it("keeps them out however they arrive", async () => {
        // A peer, a backup or a hand-edited file is not a way around the floor.
        const list = S.normalizeApplicationList([
            { id: "app:explorer.exe", enabled: true, permanent: true },
            app("taskmgr.exe", { permanent: true }),
            app("steam.exe")
        ]);
        eq(ids(list), ["app:steam.exe"]);

        const merged = S.mergeApplications([app("steam.exe")], [app("explorer.exe")], 1, 2);
        eq(ids(merged), ["app:steam.exe"], "a peer carried the shell into the fortress");
    });

    await it("reads an entry that carries only its id", async () => {
        // It used to become app:app:steam.exe — the same confusion that once
        // switched off rules 3 and 4, one layer down.
        const entry = S.normalizeApplication({ id: "app:steam.exe", enabled: true });
        eq(entry.id, "app:steam.exe");
        eq(entry.exe, "steam.exe");
    });

    describe("Normalising a list");

    await it("drops an entry with no executable rather than repairing it", async () => {
        // An application that matches no process could never be unblocked
        // either, which is worse than not being in the list at all.
        eq(S.normalizeApplication({ name: "Ghost", enabled: true }), null);
        eq(S.normalizeApplicationList([{ name: "Ghost" }, app("steam.exe")]).length, 1);
    });

    await it("collapses a duplicate to the stronger of the two", async () => {
        // Added from the picker on one device and by hand on another. Dropping
        // either silently is the one outcome that could take a defence down.
        const list = S.normalizeApplicationList([
            app("steam.exe", { enabled: false, permanent: false, name: "Steam" }),
            app("STEAM.EXE", { enabled: true, permanent: true, name: "Steam Client" })
        ]);

        eq(list.length, 1, "one program stayed two entries");
        eq(list[0].enabled, true);
        eq(list[0].permanent, true);
        eq(list[0].name, "Steam Client", "the later name did not win");
    });

    await it("will not let permanence outlive being switched off", async () => {
        const list = S.normalizeApplicationList([app("steam.exe", { enabled: false, permanent: true })]);
        eq(list[0].permanent, false, "a stale flag survived to re-apply later");
    });

    await it("hands the enforcer names and nothing else", async () => {
        const list = [
            app("steam.exe"),
            app("discord.exe", { enabled: false }),
            app("roblox.exe", { permanent: true })
        ];
        eq(S.blockedExecutables(list), ["steam.exe", "roblox.exe"]);
    });

    describe("Merging");

    await it("unions two lists that share nothing", async () => {
        const merged = S.mergeApplications([app("steam.exe")], [app("discord.exe")], 1, 1);
        eq(ids(merged), ["app:discord.exe", "app:steam.exe"]);
    });

    await it("two devices that each blocked Steam end with one Steam", async () => {
        // Independently added, no coordination, different capitalisation and a
        // different label. If the id were generated this test is the one that
        // fails, and the user is handed two identical rows they cannot tell
        // apart.
        const merged = S.mergeApplications(
            [app("steam.exe", { name: "Steam" })],
            [app("Steam.EXE", { name: "steam" })],
            1, 2
        );
        eq(merged.length, 1, "one program became two entries");
        eq(merged[0].id, "app:steam.exe");
    });

    await it("resolves toward stricter on both flags", async () => {
        const merged = S.mergeApplication(
            app("steam.exe", { enabled: false, permanent: false }),
            app("steam.exe", { enabled: true, permanent: true }),
            1, 1
        );
        eq(merged.enabled, true, "blocked lost to not blocked");
        eq(merged.permanent, true, "permanent lost to removable");
    });

    await it("lets the newer commit name it, since a name has no direction", async () => {
        eq(S.mergeApplication(app("steam.exe", { name: "Mine" }),
                              app("steam.exe", { name: "Theirs" }), 1, 5).name, "Theirs");
        eq(S.mergeApplication(app("steam.exe", { name: "Mine" }),
                              app("steam.exe", { name: "Theirs" }), 5, 1).name, "Mine");
    });

    await it("changes nothing when a settled state is merged again", async () => {
        // The property the whole tick depends on. This runs forever; a rule
        // that drifts on repeat drifts without limit.
        const settled = [app("steam.exe", { permanent: true }), app("discord.exe", { enabled: false })];

        const once = S.mergeApplications(settled, settled, 3, 3);
        const twice = S.mergeApplications(once, once, 3, 3);
        eq(twice, once, "merging a settled state with itself moved it");
    });

    await it("survives a peer that has never heard of applications", async () => {
        // A fortress that has not upgraded sends no `applications` at all.
        // Absent has to read as "I have none", never as "remove yours" —
        // strengthen-wins is the whole contract.
        const merged = S.mergeApplications([app("steam.exe")], undefined, 1, 1);
        eq(ids(merged), ["app:steam.exe"], "an older peer took a defence down by omission");
    });

    describe("What a weakening record captures");

    await it("names an application removed and one switched off", async () => {
        const before = {
            categories: [], manualSites: [], task: null, cooldown: null,
            applications: [app("steam.exe"), app("discord.exe")]
        };
        const after = {
            categories: [], manualSites: [], task: null, cooldown: null,
            applications: [app("discord.exe", { enabled: false })]
        };

        const r = S.describeAuthoredWeakening(before, after);
        ok(r, "taking two programs down produced no record");
        eq(r.applicationsRemoved, ["app:steam.exe"]);
        eq(r.applicationsDisabled, ["app:discord.exe"]);
    });

    await it("says nothing when a program is added or switched on", async () => {
        const before = {
            categories: [], manualSites: [], task: null, cooldown: null,
            applications: [app("steam.exe", { enabled: false })]
        };
        const after = {
            categories: [], manualSites: [], task: null, cooldown: null,
            applications: [app("steam.exe"), app("discord.exe")]
        };
        eq(S.describeAuthoredWeakening(before, after), null);
    });

    await it("reads a record written before applications existed", async () => {
        // Every record in a 1.12 fortress. Absent lists have to normalize to
        // empty rather than undefined, or applying one throws mid-merge.
        const record = S.normalizeAuthored({ rev: 2, at: 5, device: "chrome", taskCleared: true });
        eq(record.applicationsRemoved, []);
        eq(record.applicationsDisabled, []);
    });

    describe("A weakening travelling");

    await it("a removal made in the app reaches the browser", async () => {
        const ext = peer("extension", [app("steam.exe"), app("discord.exe")]);
        const desktop = peer("app", [app("steam.exe"), app("discord.exe")]);

        commit(desktop, { applications: [app("discord.exe")] });
        syncInto(ext, desktop);

        eq(ids(ext.fortress.applications), ["app:discord.exe"],
            "the browser put back a program the user removed");
    });

    await it("a plain disagreement never takes a program down", async () => {
        // No record: two views crossing in the post, not a decision.
        const ext = peer("extension", [app("steam.exe"), app("discord.exe")]);
        const desktop = peer("app", [app("steam.exe")]);

        syncInto(ext, desktop);
        eq(ids(ext.fortress.applications), ["app:discord.exe", "app:steam.exe"],
            "a program stopped being blocked with nobody deciding to");
    });

    await it("a removal yields to a program put back afterwards", async () => {
        // The device holds its own record AND has the program, which is what
        // says the rebuild happened second. Replaying the record would undo a
        // decision the user has already changed their mind about.
        const had = { categories: [], manualSites: [], task: null, cooldown: null,
                      applications: [app("steam.exe")] };
        const gone = { categories: [], manualSites: [], task: null, cooldown: null,
                       applications: [] };

        const record = Object.assign({ rev: 2, at: 0, device: "app" },
            S.describeAuthoredWeakening(had, gone));

        // The record sits with the peer that is WITHOUT the program, which is
        // what makes it a reason rather than a stale replay. It crosses.
        const fresh = S.mergeFortress(had, gone, 1, 2, null, [record]);
        eq(ids(fresh.applications), [], "an ordinary removal did not cross");

        // Now the holder is the peer that HAS it back. Holding the record and
        // having the thing is what says the rebuild happened second, so the
        // record is spent and must not undo it.
        const rebuilt = S.mergeFortress(had, gone, 9, 2, [record], null);
        eq(ids(rebuilt.applications), ["app:steam.exe"], "a superseded removal replayed");
    });

    await it("switching one off travels, and takes its permanence with it", async () => {
        const on = { categories: [], manualSites: [], task: null, cooldown: null,
                     applications: [app("steam.exe", { permanent: true })] };
        const off = { categories: [], manualSites: [], task: null, cooldown: null,
                      applications: [app("steam.exe", { enabled: false, permanent: false })] };

        const record = Object.assign({ rev: 2, at: 0, device: "app" },
            S.describeAuthoredWeakening(on, off));
        eq(record.applicationsDisabled, ["app:steam.exe"]);

        const merged = S.mergeFortress(on, off, 1, 2, null, [record]);
        eq(merged.applications[0].enabled, false, "a program stayed blocked after being switched off");
        eq(merged.applications[0].permanent, false,
            "permanence outlived the block it belonged to");
    });

    await it("carries a removal to a peer that was away for both of them", async () => {
        // Two removals before a single sync tick. The single-slot design lost
        // the first of these; the appended list is why it survives.
        const ext = peer("extension", [app("steam.exe"), app("discord.exe"), app("roblox.exe")]);
        const desktop = peer("app", [app("steam.exe"), app("discord.exe"), app("roblox.exe")]);

        commit(desktop, { applications: [app("discord.exe"), app("roblox.exe")] });
        commit(desktop, { applications: [app("roblox.exe")] });
        syncInto(ext, desktop);

        eq(ids(ext.fortress.applications), ["app:roblox.exe"],
            "one of two removals made before a sync was lost");
    });

    describe("What the seal says out loud");

    await it("names the program, not the executable", async () => {
        // Read at the moment someone would rather not be reading. It has to
        // name something they recognise.
        const scope = loadSharedLayer().scope;
        const before = { categories: [], manualSites: [],
                         applications: [app("steam.exe", { name: "Steam" })] };
        const after = { categories: [], manualSites: [], applications: [] };

        const lines = [];
        scope.describeApplicationChanges(before.applications, after.applications, lines);
        eq(lines, ["Steam removed — that program stops being blocked."]);
    });

    await it("stays quiet about a program that was already switched off", async () => {
        const scope = loadSharedLayer().scope;
        const before = { applications: [app("steam.exe", { enabled: false })] };
        const after = { applications: [] };

        const lines = [];
        scope.describeApplicationChanges(before.applications, after.applications, lines);
        eq(lines, [], "the prompt padded itself with a block that was not standing");
    });

    return report("applications");
}

run().then((code) => process.exit(code));
