// Tests/authored.test.js — the path a deliberate weakening travels.
//
//     node Tests/authored.test.js
//
// The merge is strengthen-wins: it can raise a defence but never lower one.
// The single exception is an *authored* record, written the moment the user
// passed the seal or a friction gate, which says a defence was taken down on
// purpose. That record is the only thing standing between a confused merge and
// a fortress quietly rebuilding itself around someone who dismantled it.
//
// sync.test.js covers the merge rules one function at a time. This covers the
// journey: commit on one peer, sync, and check what the other peer is actually
// enforcing afterwards — including when the two disagree, when a sync is
// missed, and when a peer has been away.

const { loadSharedLayer, createHarness } = require("./load");

const S = loadSharedLayer().api;
const { describe, it, eq, ok, report } = createHarness();

const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- A peer ---------------------------------------------------------------
//
// Enough of a device to commit and to sync. The fortress fields are real; the
// rest is the minimum mergePeerState needs.

let revClock = 0;

function peer(name, categories, extra) {
    return Object.assign({
        name: name,
        today: "2026-09-06",
        events: [],
        counters: {},
        fortressRev: 0,
        authored: [],
        stats: { dayLogSeeded: true },
        dayLog: {},
        fortress: {
            categories: clone(categories),
            manualSites: [],
            task: null,
            cooldown: { seconds: 300, escalate: false, factor: 1.25 }
        },
        seal: { enabled: false },
        sealAttempts: { failures: 0, lockedUntil: 0 },
        escalation: {},
        tempUnlocks: {}
    }, extra || {});
}

function category(id, overrides) {
    return Object.assign({
        id: id,
        name: id,
        color: "gold",
        glyph: "◆",
        sites: [`${id}.com`],
        enabled: true,
        permanent: false
    }, overrides || {});
}

// What commitFortress does: work out whether this edit weakens, stamp a
// revision, and keep the record if it does.
function commit(p, next) {
    const before = clone(p.fortress);
    const after = Object.assign(clone(p.fortress), next);

    const record = S.describeAuthoredWeakening(before, after);
    p.fortressRev = ++revClock;
    p.fortress = after;

    if (record) {
        // Appended with a stable id, as stampCommit() does.
        p.authored = p.authored.concat([Object.assign({
            id: `${p.name}:${p.fortressRev}`,
            rev: p.fortressRev,
            at: Date.now() + p.fortressRev,
            device: p.name
        }, record)]);
    }

    return record;
}

// One direction: `to` receives `from`'s state and merges it, exactly as
// syncNow() would. Returns what `to` now enforces.
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

    // applyMerge() keeps the merged list rather than clearing it, which is
    // what carries a record on to a peer that was away.
    to.authored = merged.authored;

    return to;
}

const ids = (p) => p.fortress.categories.map((c) => c.id).sort();
const has = (p, id) => p.fortress.categories.some((c) => c.id === id);
const enabled = (p, id) => {
    const c = p.fortress.categories.find((x) => x.id === id);
    return Boolean(c && c.enabled);
};

// ---- Tests ----------------------------------------------------------------

async function run() {
    describe("What a weakening record captures");

    await it("names every kind of defence coming down", async () => {
        const before = {
            categories: [
                category("gaming", { sites: ["roblox.com", "steam.com"] }),
                category("social"),
                category("news", { task: { type: "passage" }, cooldown: { seconds: 600, escalate: true, factor: 2 } })
            ],
            manualSites: ["espn.com", "bbc.com"],
            task: { type: "passage" },
            cooldown: { seconds: 600, escalate: true, factor: 2 }
        };
        const after = {
            categories: [
                category("gaming", { sites: ["roblox.com"] }),        // a site removed
                category("social", { enabled: false }),               // switched off
                category("news")                                      // own standards dropped
            ],
            manualSites: ["espn.com"],                                // a hand block removed
            task: null,                                               // task cleared
            cooldown: { seconds: 60, escalate: false, factor: 2 }     // cooldown shortened
        };

        const r = S.describeAuthoredWeakening(before, after);
        ok(r, "a weakening produced no record at all");
        eq(r.sitesRemoved, { gaming: ["steam.com"] });
        eq(r.categoriesDisabled, ["social"]);
        eq(r.standardsCleared, ["news"]);
        eq(r.manualRemoved, ["bbc.com"]);
        eq(r.taskCleared, true);
        eq(r.cooldownLowered, true);
    });

    await it("says nothing when the fortress only gets stronger", async () => {
        const before = { categories: [category("gaming")], manualSites: [], task: null,
                         cooldown: { seconds: 300, escalate: false, factor: 1.25 } };
        const after = {
            categories: [category("gaming", { sites: ["gaming.com", "steam.com"], permanent: true }),
                         category("social")],
            manualSites: ["espn.com"],
            task: { type: "code" },
            cooldown: { seconds: 900, escalate: true, factor: 2 }
        };
        eq(S.describeAuthoredWeakening(before, after), null);
    });

    describe("A weakening travelling");

    await it("crosses from the browser to the app", async () => {
        const ext = peer("extension", [category("gaming"), category("social")]);
        const app = peer("app", [category("gaming"), category("social")]);

        commit(ext, { categories: [category("gaming")] });
        syncInto(app, ext);

        eq(ids(app), ["gaming"], "the app kept a category the user removed");
    });

    await it("crosses from the app to the browser", async () => {
        const ext = peer("extension", [category("gaming"), category("social")]);
        const app = peer("app", [category("gaming"), category("social")]);

        commit(app, { categories: [category("gaming")] });
        syncInto(ext, app);

        eq(ids(ext), ["gaming"], "the browser kept a category the user removed");
    });

    await it("a plain disagreement never takes a defence down", async () => {
        // No record: this is two views crossing in the post, not a decision.
        const ext = peer("extension", [category("gaming"), category("social")]);
        const app = peer("app", [category("gaming")]);

        syncInto(ext, app);
        eq(ids(ext), ["gaming", "social"], "a defence came down with nobody deciding to");
    });

    await it("a removal undone before syncing does not travel", async () => {
        const ext = peer("extension", [category("gaming"), category("social")]);
        const app = peer("app", [category("gaming"), category("social")]);

        commit(ext, { categories: [category("gaming")] });
        commit(ext, { categories: [category("gaming"), category("social")] });  // put back

        syncInto(app, ext);
        eq(ids(app), ["gaming", "social"], "a change the user reversed still crossed");
    });

    describe("Weakenings that arrive together, or late");

    await it("two removals before one sync both cross", async () => {
        // The user takes two categories down in a row, then the tick fires
        // once. Nothing about that is unusual, and both removals were
        // deliberate.
        const ext = peer("extension", [category("gaming"), category("social"), category("news")]);
        const app = peer("app", [category("gaming"), category("social"), category("news")]);

        commit(ext, { categories: [category("gaming"), category("news")] });   // social out
        commit(ext, { categories: [category("gaming")] });                     // news out

        syncInto(app, ext);
        eq(ids(app), ["gaming"], "only the last removal crossed; the earlier one came back");
    });

    await it("reaches a peer that was away when it happened", async () => {
        // Three peers: the browser, the desktop app, and a second browser that
        // was closed. The removal must reach it whenever it next appears.
        const ext = peer("extension", [category("gaming"), category("social")]);
        const app = peer("app", [category("gaming"), category("social")]);
        const away = peer("second browser", [category("gaming"), category("social")]);

        commit(ext, { categories: [category("gaming")] });
        syncInto(app, ext);
        eq(ids(app), ["gaming"], "precondition: the app took the removal");

        // The away peer comes back and syncs with the app.
        syncInto(away, app);
        eq(ids(away), ["gaming"], "a peer that was away never learned of the removal");

        // And must not push the category back into the app.
        syncInto(app, away);
        eq(ids(app), ["gaming"], "the returning peer resurrected the removed category");
    });

    describe("Records that must not replay");

    await it("a removal cannot undo a category added since", async () => {
        const ext = peer("extension", [category("gaming"), category("social")]);
        const app = peer("app", [category("gaming"), category("social")]);

        commit(ext, { categories: [category("gaming")] });
        syncInto(app, ext);

        // The user changes their mind on the app and rebuilds it.
        commit(app, { categories: [category("gaming"), category("social")] });
        syncInto(ext, app);
        eq(ids(ext), ["gaming", "social"], "the rebuild did not reach the browser");

        // The browser's old record must not now take it away again.
        syncInto(app, ext);
        eq(ids(app), ["gaming", "social"], "a stale record removed a rebuilt category");
    });

    await it("applying the same record twice changes nothing", async () => {
        const ext = peer("extension", [category("gaming"), category("social")]);
        const app = peer("app", [category("gaming"), category("social")]);

        commit(ext, { categories: [category("gaming")] });
        syncInto(app, ext);
        const once = ids(app);

        syncInto(app, ext);
        eq(ids(app), once, "a second sync of the same record moved the fortress");
    });

    describe("Both sides at once");

    await it("two different removals, one on each side, both hold", async () => {
        const ext = peer("extension", [category("gaming"), category("social"), category("news")]);
        const app = peer("app", [category("gaming"), category("social"), category("news")]);

        commit(ext, { categories: [category("gaming"), category("news")] });   // social out
        commit(app, { categories: [category("gaming"), category("social")] }); // news out

        syncInto(app, ext);
        syncInto(ext, app);

        eq(ids(ext), ["gaming"], "the browser lost one of the two removals");
        eq(ids(app), ["gaming"], "the app lost one of the two removals");
    });

    await it("a removal on one side and a block added on the other keep both", async () => {
        const ext = peer("extension", [category("gaming"), category("social")]);
        const app = peer("app", [category("gaming"), category("social")]);

        commit(ext, { categories: [category("gaming")] });                     // social out
        commit(app, { categories: [category("gaming"), category("social"), category("video")] });

        syncInto(app, ext);
        syncInto(ext, app);

        // Strengthening always survives; the removal was deliberate and also
        // survives. They are not in conflict — they are about different things.
        ok(has(ext, "video"), "the new category was lost");
        ok(!has(ext, "social"), "the removal was undone by the other side's edit");
        eq(ids(ext), ids(app), "the two peers did not converge");
    });

    await it("disabling on one side survives the other's ignorance", async () => {
        const ext = peer("extension", [category("gaming"), category("social")]);
        const app = peer("app", [category("gaming"), category("social")]);

        commit(ext, { categories: [category("gaming"), category("social", { enabled: false })] });
        syncInto(app, ext);

        eq(enabled(app, "social"), false, "a deliberate disable was overridden by enabled-wins");
        ok(has(app, "social"), "disabling removed the category instead of switching it off");
    });

    process.exit(report("authored") ? 1 : 0);
}

run();
