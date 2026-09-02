// Tests/backup.test.js — exporting and restoring a fortress.
//
//     node Tests/backup.test.js
//
// The case this exists for is the one that actually happened: an unpacked
// extension's storage was deleted, and there was no copy. So the central test
// here is that exact sequence — export, lose everything, import, and get the
// record back.
//
// The rest are the ways a restore can go wrong quietly: carrying a device
// identity across so counters double, taking a defence down because the backup
// predates it, or doubling the history when someone clicks Import twice.

const { loadSharedLayer, createHarness } = require("./load");

const { scope: G, store } = loadSharedLayer();
const { describe, it, eq, ok, report } = createHarness();

// ---- Fixtures -------------------------------------------------------------

function seedFortress() {
    wipe();

    Object.assign(store, {
        stats: {
            currentStreak: 12, longestStreak: 31,
            lastCleanDate: "2026-08-31", lastUnlockDate: "2026-08-19", lastUnlockAt: 1_700_000,
            stayFocusedCount: 0, unlockCount: 0,
            currentResistance: 0, longestResistance: 64,
            dayLogSeeded: true, historyStartedOn: "2026-04-03"
        },
        dayLog: {
            "2026-08-30": { stands: 5, unlocks: 0, sites: {}, firstSlip: null, inferred: false },
            "2026-08-19": { stands: 1, unlocks: 2, sites: { "youtube.com": 2 }, firstSlip: "21:04", inferred: false }
        },
        categoryDefs: [
            { id: "socialMedia", name: "Social Media", color: "crimson", glyph: "◆",
              enabled: true, permanent: false, sites: ["facebook.com", "reddit.com", "x.com"] },
            { id: "gaming", name: "Gaming", color: "verdant", glyph: "●",
              enabled: true, permanent: false, sites: ["roblox.com"] }
        ],
        manualSites: ["espn.com"],
        unlockTask: { type: "passage" },
        cooldownSettings: { seconds: 300, escalate: true, factor: 1.5 },
        seal: { enabled: true, algorithm: "PBKDF2-SHA256", iterations: 250000,
                salt: "s", verifier: "v", hint: "the usual", recovery: null },
        syncDevice: { id: "old-device", surface: "extension", createdAt: 1 },
        syncMeta: { fortressRev: 7, counters: { "old-device": { stands: 214, unlocks: 37 } },
                    authored: null, lastSyncedAt: 0 },
        syncEvents: [
            { id: "ev1", type: "stand", device: "old-device", at: 1_000, date: "2026-08-30" },
            { id: "ev2", type: "unlock", device: "old-device", at: 2_000, date: "2026-08-19",
              domain: "youtube.com", time: "21:04" }
        ]
    });
}

// What the disaster looked like: the bucket deleted and recreated, so the
// extension comes back up as a first run with the default seed.
function wipeToFreshInstall() {
    wipe();
    Object.assign(store, {
        stats: {
            currentStreak: 1, longestStreak: 1, lastCleanDate: "2026-09-01",
            lastUnlockDate: null, lastUnlockAt: 0, stayFocusedCount: 0, unlockCount: 0,
            currentResistance: 0, longestResistance: 0,
            dayLogSeeded: true, historyStartedOn: "2026-09-01"
        },
        dayLog: {},
        categoryDefs: [
            { id: "socialMedia", name: "Social Media", color: "crimson", glyph: "◆",
              enabled: false, permanent: false, sites: ["facebook.com", "reddit.com", "x.com"] }
        ],
        manualSites: [],
        syncDevice: { id: "new-device", surface: "extension", createdAt: 9 },
        syncMeta: { fortressRev: 1, counters: { "new-device": { stands: 0, unlocks: 0 } },
                    authored: null, lastSyncedAt: 0 },
        syncEvents: []
    });
}

function wipe() {
    Object.keys(store).forEach((k) => delete store[k]);
}

// ---- Tests ----------------------------------------------------------------

async function run() {
    describe("Export");

    let backup = null;

    await it("carries the record, and stamps what wrote it", async () => {
        seedFortress();
        backup = await G.buildFortressBackup();

        eq(backup.format, "dominus-fortress-backup");
        eq(backup.formatVersion, 1);
        eq(backup.exportedBy, "1.11");
        ok(backup.exportedAt, "the backup carried no date");

        eq(backup.stats.longestStreak, 31);
        eq(Object.keys(backup.dayLog).sort(), ["2026-08-19", "2026-08-30"]);
        eq(backup.events.length, 2);
        eq(backup.counters, { "old-device": { stands: 214, unlocks: 37 } });
        eq(backup.fortress.categories.map((c) => c.id), ["socialMedia", "gaming"]);
        eq(backup.fortress.manualSites, ["espn.com"]);
        eq(backup.seal.enabled, true, "a sealed fortress exported as unsealed");
    });

    await it("never carries a device identity or a live unlock", async () => {
        // Two devices sharing an id would have their per-device counters merged
        // as one, and every stand on the second would overwrite the first
        // instead of adding to it.
        ok(!("syncDevice" in backup), "the device identity was about to travel");

        // A live unlock window is session state. Carrying one hands a machine
        // access it never paid the cooldown for.
        ok(!("tempUnlocks" in backup), "a live unlock window was about to travel");
        ok(!("escalationState" in backup), "escalation state was about to travel");

        // The seal's PBKDF2 verifier travels; the password never existed in
        // storage to travel with it.
        ok(!("password" in backup.seal), "something password-shaped was in the file");
    });

    describe("Restore — the disaster");

    await it("brings a wiped fortress back", async () => {
        wipeToFreshInstall();
        const result = await G.importFortressBackup(backup);

        ok(result.imported, "the import reported failure");

        const after = await G.readPeerState();
        eq(after.stats.longestStreak, 31, "the record streak did not come back");
        eq(after.stats.stayFocusedCount, 214, "the all-time stands did not come back");
        eq(after.stats.unlockCount, 37);
        eq(after.stats.historyStartedOn, "2026-04-03", "history start was not restored");
        eq(Object.keys(after.dayLog).sort(), ["2026-08-19", "2026-08-30"]);
        eq(after.fortress.categories.map((c) => c.id).sort(), ["gaming", "socialMedia"]);
        eq(after.fortress.manualSites, ["espn.com"]);
        eq(after.seal.enabled, true, "the seal did not come back");
    });

    await it("keeps this browser's own identity", async () => {
        const device = await new Promise((r) =>
            G.chrome.storage.local.get(["syncDevice"], (x) => r(x.syncDevice)));

        eq(device.id, "new-device", "the restore overwrote this device's identity");

        // Both devices' totals are present and summed, rather than one having
        // replaced the other.
        const meta = await new Promise((r) =>
            G.chrome.storage.local.get(["syncMeta"], (x) => r(x.syncMeta)));
        eq(Object.keys(meta.counters).sort(), ["new-device", "old-device"]);
    });

    await it("re-derives what is enforced rather than trusting the file", async () => {
        const blocked = await new Promise((r) =>
            G.chrome.storage.local.get(["blockedSites"], (x) => r(x.blockedSites)));

        // blockedSites is a cache of the categories and the manual list. It is
        // never exported and never imported — it is rebuilt, so what is
        // enforced can't disagree with what is shown.
        eq(blocked.slice().sort(), ["espn.com", "facebook.com", "reddit.com", "roblox.com", "x.com"]);
    });

    describe("Restore — the ways it could go wrong quietly");

    await it("importing the same file twice changes nothing", async () => {
        const before = await G.readPeerState();
        const result = await G.importFortressBackup(backup);
        const after = await G.readPeerState();

        eq(after.stats.stayFocusedCount, before.stats.stayFocusedCount,
            "a second import doubled the all-time stands");
        eq(after.events.length, before.events.length, "a second import doubled the event log");
        eq(after.dayLog, before.dayLog, "a second import moved the day log");
        eq(result.summary, "Nothing new — this fortress already had everything in that file.");
    });

    await it("an old backup cannot take down a defence added since", async () => {
        // The fortress has gained a category and a hand-blocked site since the
        // backup was made. Restoring must not roll either of them back: the
        // merge is strengthen-wins and a backup carries no authored weakening.
        store.categoryDefs = store.categoryDefs.concat([{
            id: "news", name: "News", color: "azure", glyph: "▲",
            enabled: true, permanent: false, sites: ["news.example"]
        }]);
        store.manualSites = ["espn.com", "added-later.com"];

        await G.importFortressBackup(backup);
        const after = await G.readPeerState();

        eq(after.fortress.categories.map((c) => c.id).sort(),
            ["gaming", "news", "socialMedia"], "an old backup removed a category");
        ok(after.fortress.manualSites.includes("added-later.com"),
            "an old backup removed a hand-blocked site");
    });

    await it("a backup merges histories rather than replacing one", async () => {
        // Days recorded after the export must survive the restore alongside the
        // days only the backup knows about.
        store.dayLog["2026-09-05"] = {
            stands: 3, unlocks: 0, sites: {}, firstSlip: null, inferred: false
        };

        await G.importFortressBackup(backup);
        const after = await G.readPeerState();

        eq(Object.keys(after.dayLog).sort(),
            ["2026-08-19", "2026-08-30", "2026-09-05"],
            "the restore lost a day that only this browser knew about");
    });

    describe("Bad files");

    await it("refuses something that isn't a Dominus backup", async () => {
        await rejects(() => G.importFortressBackup({ hello: "world" }),
            "That file isn't a Dominus backup.");
        await rejects(() => G.importFortressBackup(null),
            "That file isn't a Dominus backup.");
    });

    await it("refuses a backup from a newer Dominus", async () => {
        await rejects(
            () => G.importFortressBackup(Object.assign({}, backup, { formatVersion: 99 })),
            "That backup was made by a newer version of Dominus than this one.");
    });

    await it("survives a truncated or hand-edited file", async () => {
        seedFortress();

        // Every field junk, but the header intact: it must produce a valid
        // fortress rather than throwing or writing nonsense into storage.
        await G.importFortressBackup({
            format: "dominus-fortress-backup",
            formatVersion: 1,
            stats: "not an object",
            dayLog: { "not-a-date": { stands: 9 }, "2026-08-30": null },
            events: "nope",
            counters: 42,
            fortress: { categories: "nope", manualSites: 7, cooldown: { seconds: -5 } },
            seal: { enabled: "yes" }
        });

        const after = await G.readPeerState();
        eq(after.stats.longestStreak, 31, "junk overwrote the real stats");
        ok(!("not-a-date" in after.dayLog), "a non-date key entered the day log");
        eq(after.fortress.categories.map((c) => c.id), ["socialMedia", "gaming"],
            "junk removed the real categories");
        ok(after.fortress.cooldown.seconds >= 60,
            "a negative cooldown got through the floor");
    });

    process.exit(report("backup") ? 1 : 0);
}

async function rejects(fn, message) {
    try {
        await fn();
    } catch (error) {
        if (message && error.message !== message) {
            throw new Error(`wrong message\n      expected ${message}\n      actual   ${error.message}`);
        }
        return;
    }
    throw new Error("expected a rejection, got none");
}

run();
