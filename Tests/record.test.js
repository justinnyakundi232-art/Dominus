// Tests/record.test.js — the recording path, against a real storage stub.
//
//     node Tests/record.test.js
//
// sync.test.js covers the merge rules, which are pure functions fed synthetic
// peers. This covers the other half: the code that actually reaches storage on
// every stand, every unlock and every fortress commit.
//
// Both halves are needed. A merge rule that is perfect is worth nothing if
// nothing ever reaches the log to be merged — and that failure would be silent
// until Phase 2, when a second peer arrives and finds no history to merge.

const { loadSharedLayer, createHarness } = require("./load");

const { api: S, scope: G, store } = loadSharedLayer();
const { describe, it, eq, ok, report } = createHarness();

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

async function run() {
    describe("Events");

    await it("a stand writes one event and raises this device's counter", async () => {
        await G.recordSyncStand();

        const events = store.syncEvents || [];
        eq(events.length, 1, "the stand was not logged");
        eq(events[0].type, S.EVENT_STAND);
        ok(events[0].id, "the event carried no id");
        ok(events[0].date, "the event carried no local date");
        ok(events[0].at > 0, "the event carried no timestamp");

        eq(store.syncMeta.counters[store.syncDevice.id], { stands: 1, unlocks: 0 });
    });

    await it("an unlock carries the domain and the local time", async () => {
        await G.recordSyncUnlock("youtube.com");

        const events = store.syncEvents;
        const slip = events[events.length - 1];

        eq(slip.type, S.EVENT_UNLOCK);
        eq(slip.domain, "youtube.com");
        ok(/^\d{2}:\d{2}$/.test(slip.time), `expected HH:MM, got ${slip.time}`);

        // The domain and the time are the two fields that make a slip legible a
        // month later — "youtube.com at 23:46" explains a day that a bare count
        // never could, which is what 1.10 added them for.
        eq(store.syncMeta.counters[store.syncDevice.id], { stands: 1, unlocks: 1 });
    });

    await it("the recorded date is the device's local date, not derived from UTC", async () => {
        const slip = store.syncEvents[store.syncEvents.length - 1];
        const local = new Date(slip.at);
        const expected = [
            local.getFullYear(),
            String(local.getMonth() + 1).padStart(2, "0"),
            String(local.getDate()).padStart(2, "0")
        ].join("-");

        // A slip at 1am belongs to the day it felt like. Deriving the date from
        // the timestamp on a peer in another timezone would move it to a
        // different square in the history grid.
        eq(slip.date, expected);
    });

    describe("Races");

    await it("the device id is minted once, however many callers", async () => {
        // Two pages opening at once must not each mint an id. A device that
        // changes its id looks like a brand new peer, and its all-time counters
        // would be added to the total a second time.
        const before = store.syncDevice.id;
        const devices = await Promise.all([
            G.ensureDevice(), G.ensureDevice(), G.ensureDevice()
        ]);

        eq(devices.map((d) => d.id), [before, before, before]);
    });

    await it("concurrent stands do not clobber each other", async () => {
        // Why recordSyncEvent runs on a serialized queue: it is a
        // read-modify-write against storage, and two fired at once otherwise
        // lose one — the same reason enqueueStatsUpdate exists in Stats.js.
        const startEvents = store.syncEvents.length;
        const startStands = store.syncMeta.counters[store.syncDevice.id].stands;

        await Promise.all([
            G.recordSyncStand(), G.recordSyncStand(),
            G.recordSyncStand(), G.recordSyncStand()
        ]);

        eq(store.syncEvents.length, startEvents + 4, "an event was lost to a race");
        eq(store.syncMeta.counters[store.syncDevice.id].stands, startStands + 4,
            "a counter increment was lost to a race");
    });

    await it("every event id is unique", async () => {
        const ids = new Set(store.syncEvents.map((e) => e.id));
        eq(ids.size, store.syncEvents.length,
            "two events share an id — the union merge would drop one");
    });

    describe("Commits");

    await it("strengthening raises the revision and authors nothing", async () => {
        const before = {
            categories: [category({ id: "social" })],
            manualSites: ["news.com"],
            task: null,
            cooldown: null
        };
        const after = {
            categories: [category({ id: "social" }), category({ id: "gaming" })],
            manualSites: ["news.com", "extra.com"],
            task: null,
            cooldown: null
        };

        await G.stampCommit(before, after);

        eq(store.syncMeta.fortressRev, 1, "the revision did not advance");
        eq(store.syncMeta.authored, null,
            "strengthening the fortress produced a weakening record");
    });

    await it("weakening authors a record tied to its own revision", async () => {
        const before = {
            categories: [category({ id: "social" })],
            manualSites: ["news.com"],
            task: { id: "randomPassage" },
            cooldown: null
        };
        const after = { categories: [], manualSites: [], task: null, cooldown: null };

        await G.stampCommit(before, after);

        eq(store.syncMeta.fortressRev, 2);
        ok(store.syncMeta.authored, "a real weakening produced no record");
        eq(store.syncMeta.authored.rev, 2,
            "the record was not tied to the revision that made it");
        eq(store.syncMeta.authored.categoriesRemoved, ["social"]);
        eq(store.syncMeta.authored.manualRemoved, ["news.com"]);
        eq(store.syncMeta.authored.taskCleared, true);
    });

    await it("a commit is logged as an event", async () => {
        const commits = store.syncEvents.filter((e) => e.type === S.EVENT_COMMIT);
        eq(commits.length, 2, "commits were not logged");
        eq(commits.map((e) => e.rev), [1, 2], "commit events lost their revision");
    });

    describe("What travels");

    await it("what this device would send a peer is complete", async () => {
        const state = await G.readPeerState();

        ["today", "events", "counters", "fortressRev", "authored", "stats",
         "dayLog", "fortress", "seal", "sealAttempts", "escalation",
         "tempUnlocks"].forEach((key) => {
            ok(key in state, `readPeerState omitted ${key}`);
        });

        eq(state.fortressRev, 2, "the revision did not travel");
        ok(state.events.length > 0, "the event log did not travel");
    });

    await it("blockedSites never travels", async () => {
        const state = await G.readPeerState();

        // It is a cache of the categories and the manual list, read by
        // Background.js on every navigation. A peer that took it at face value
        // could end up enforcing a list its own categories disagree with —
        // the drift writeFortress() exists to prevent.
        ok(!("blockedSites" in state),
            "blockedSites was about to be sent to a peer");
        ok(!("blockedSites" in (state.fortress || {})),
            "blockedSites was about to be sent inside the fortress");
    });

    await it("syncNow does nothing until a transport is installed", async () => {
        eq(await G.syncNow(), { status: "no-peer" });
    });

    process.exit(report("record") ? 1 : 0);
}

run();
