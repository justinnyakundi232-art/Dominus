// Tests/authored.test.js — a weakening's journey between peers.
//
//     node Tests/authored.test.js
//
// The one exception to strengthen-wins, and the thing standing between a
// confused merge and a fortress quietly rebuilding itself around someone who
// dismantled it.
//
// The first design was a single record, replaced on each commit and applied
// when `record.rev > myRev`. Six of the thirteen scenarios below fail against
// it, and they are the six that matter — the ordinary ones. Revisions count
// commits PER DEVICE, so one peer's 1 and another's 2 say nothing about which
// happened first, and two peers each removing something had BOTH removals
// silently ignored.
//
// Every test here is written against the four rules argued above mergeAuthored()
// in Sync.js. Where a test exists because a specific scenario failed without a
// rule, the comment says which.

const { loadSharedLayer, createHarness } = require("./load.js");

const { api: S } = loadSharedLayer();
const { describe, it, eq, ok, report } = createHarness();

// ---- A two-peer world -----------------------------------------------------
//
// A peer is a fortress, a revision, and the records it holds. Deliberately the
// same shape mergePeerState() exchanges, so these scenarios are the real merge
// and not a model of it.

let clock = 1000;

function peer(name, fortress) {
    return {
        name: name,
        rev: 0,
        fortress: Object.assign(
            { categories: [], manualSites: [], task: null, cooldown: null },
            fortress
        ),
        authored: []
    };
}

function category(over) {
    return Object.assign({
        id: "social",
        name: "Social",
        color: "#D4AF37",
        glyph: "S",
        sites: ["x.com"],
        enabled: true,
        permanent: false
    }, over || {});
}

// A local edit, through the same two steps commitFortress() takes: work out
// what was given up, raise the revision, append the record if anything was.
function commit(p, next) {
    const before = p.fortress;
    const after = Object.assign({}, before, next);
    const authored = S.describeAuthoredWeakening(before, after);

    p.rev += 1;
    p.fortress = after;

    if (authored) {
        p.authored = S.normalizeAuthoredList(p.authored.concat([
            Object.assign({ rev: p.rev, at: clock++, device: p.name }, authored)
        ]));
    }

    return p;
}

// One reconcile, both ways.
//
// The protocol is one merge, not two: the extension runs mergePeerState() and
// hands the app the result under compare-and-set, so both peers land on exactly
// the same state. Simulating it as two independent merges would be testing a
// design the wire does not implement.
function reconcile(a, b) {
    const fortress = S.mergeFortress(
        a.fortress, b.fortress, a.rev, b.rev, a.authored, b.authored
    );
    const authored = S.mergeAuthored(a.authored, b.authored);
    const rev = Math.max(a.rev, b.rev);

    [a, b].forEach((p) => {
        p.fortress = JSON.parse(JSON.stringify(fortress));
        p.authored = JSON.parse(JSON.stringify(authored));
        p.rev = rev;
    });

    return fortress;
}

const ids = (p) => (p.fortress.categories || []).map((c) => c.id);
const has = (p, id) => ids(p).includes(id);

// ===========================================================================
describe("A weakening crosses");

it("1. a removal reaches a peer that never saw it", () => {
    const app = peer("app", { categories: [category({ id: "social" })] });
    const chrome = peer("chrome", { categories: [category({ id: "social" })] });

    commit(app, { categories: [] });
    reconcile(app, chrome);

    eq(ids(chrome), [], "the removal did not cross");
    eq(ids(app), [], "the removal did not stick on the device that made it");
});

it("2. two removals before one sync tick both cross", () => {
    // RULE 1 — records are a list. The single slot kept only the second, and
    // the first category came back on the next merge with nobody told.
    const app = peer("app", {
        categories: [category({ id: "social" }), category({ id: "gaming" })]
    });
    const chrome = peer("chrome", {
        categories: [category({ id: "social" }), category({ id: "gaming" })]
    });

    commit(app, { categories: [category({ id: "gaming" })] });
    commit(app, { categories: [] });

    eq(app.authored.length, 2, "the first record was overwritten");
    reconcile(app, chrome);

    eq(ids(chrome), [], "one of the two removals was lost");
});

it("3. two peers each removing something keep both removals", () => {
    // The headline failure of the first design, and the reason revisions were
    // abandoned as the test. `fortressRev` counts commits PER DEVICE, so one
    // peer's 1 and another's 2 say nothing about which happened first — and a
    // record that only applied when `rev > myRev` meant two peers each taking
    // something down had BOTH removals silently ignored.
    //
    // It is also what the union in mergeAuthored() is for: a peer must adopt
    // the records it is sent WITHOUT dropping the ones it wrote itself.
    const app = peer("app", {
        categories: [category({ id: "social" }), category({ id: "gaming" })]
    });
    const chrome = peer("chrome", {
        categories: [category({ id: "social" }), category({ id: "gaming" })]
    });

    commit(app, { categories: [category({ id: "gaming" })] });
    commit(chrome, { categories: [category({ id: "social" })] });

    reconcile(app, chrome);

    eq(ids(chrome), [], "one of the two peers' removals was ignored");
    eq(chrome.authored.length, 2, "a peer dropped a record rather than adopting it");
    eq(chrome.authored.map((r) => r.device).sort(), ["app", "chrome"]);
});

it("4. a manual site, an unlock task and a category all travel in one record", () => {
    const app = peer("app", {
        categories: [category({ id: "social" })],
        manualSites: ["news.com", "forum.com"],
        task: { id: "randomPassage" }
    });
    const chrome = peer("chrome", {
        categories: [category({ id: "social" })],
        manualSites: ["news.com", "forum.com"],
        task: { id: "randomPassage" }
    });

    commit(app, { categories: [], manualSites: ["forum.com"], task: null });
    reconcile(app, chrome);

    eq(ids(chrome), []);
    eq(chrome.fortress.manualSites, ["forum.com"], "a hand-blocked site did not come down");
    eq(chrome.fortress.task, null, "a cleared task did not cross");
});

it("5. a lowered cooldown crosses, because the record carries the value", () => {
    // The merge always takes the longer, so a peer told only "this was lowered"
    // has nothing to lower TO. Before the record carried the value, this was
    // written on every commit and could never be acted on.
    const app = peer("app", { cooldown: { seconds: 600, escalate: true, factor: 2 } });
    const chrome = peer("chrome", { cooldown: { seconds: 600, escalate: true, factor: 2 } });

    commit(app, { cooldown: { seconds: 60, escalate: false, factor: 2 } });
    reconcile(app, chrome);

    eq(chrome.fortress.cooldown.seconds, 60, "the cooldown did not come down");
    eq(chrome.fortress.cooldown.escalate, false, "escalation was not switched off");
});

it("6. switching a category off crosses, and takes its permanence with it", () => {
    const app = peer("app", { categories: [category({ enabled: true, permanent: true })] });
    const chrome = peer("chrome", { categories: [category({ enabled: true, permanent: true })] });

    commit(app, { categories: [category({ enabled: false, permanent: false })] });
    reconcile(app, chrome);

    eq(chrome.fortress.categories[0].enabled, false, "the category came back on");
    eq(chrome.fortress.categories[0].permanent, false, "a stale permanence flag survived");
});

// ===========================================================================
describe("A weakening stops where it should");

it("7. a removal the user reversed before syncing does not travel", () => {
    // RULE 3 — the record is the reason, the fortress is the fact. Without the
    // holder check this still crossed, and the user watched a category they had
    // just put back disappear again.
    const app = peer("app", { categories: [category({ id: "social" })] });
    const chrome = peer("chrome", { categories: [category({ id: "social" })] });

    commit(app, { categories: [] });
    commit(app, { categories: [category({ id: "social" })] });

    reconcile(app, chrome);

    ok(has(chrome, "social"), "a reversed removal travelled anyway");
    ok(has(app, "social"), "the reversal was undone by the peer's own record");
});

it("8. a record yields to a rebuild made after it", () => {
    // RULE 4 — the far peer holds the record AND still has the thing, so it was
    // rebuilt knowingly. Replaying one's own records is necessary, because the
    // union re-adds whatever either peer has; without this rule it silently
    // undid that rebuild the moment it arrived.
    const app = peer("app", { categories: [category({ id: "social" })] });
    const chrome = peer("chrome", { categories: [category({ id: "social" })] });

    commit(app, { categories: [] });
    reconcile(app, chrome);
    eq(ids(chrome), [], "the removal did not cross in the first place");

    // Both peers now hold the record. Chrome rebuilds the category on purpose.
    commit(chrome, { categories: [category({ id: "social" })] });
    reconcile(app, chrome);

    ok(has(app, "social"), "a deliberate rebuild was undone by the record that preceded it");
    ok(has(chrome, "social"), "the rebuild did not survive its own merge");
});

it("9. a peer that was away does not push the defence back on its return", () => {
    // RULE 2 — records are kept on merge and adopted. A record that was cleared
    // reached whoever was connected at the time and was then forgotten, so a
    // second browser that happened to be closed put the category back.
    const app = peer("app", { categories: [category({ id: "social" })] });
    const chrome = peer("chrome", { categories: [category({ id: "social" })] });
    const away = peer("away", { categories: [category({ id: "social" })] });

    commit(app, { categories: [] });
    reconcile(app, chrome);

    ok(chrome.authored.length === 1, "the peer did not adopt the record it was sent");

    // The third peer comes back holding the category and no record at all. It
    // has never seen the record, so having the category is not evidence — the
    // holders are app and chrome, and both are without it.
    reconcile(chrome, away);

    eq(ids(away), [], "a peer that was away resurrected a deleted category");
    eq(ids(chrome), [], "the returning peer pushed the category back");
});

it("10. one item put back does not hold up the other two", () => {
    // Gating is item by item, not record by record: one commit can take three
    // things down and the user can change their mind about one of them.
    const app = peer("app", {
        categories: [category({ id: "social" }), category({ id: "gaming" })],
        manualSites: ["news.com"]
    });
    const chrome = peer("chrome", {
        categories: [category({ id: "social" }), category({ id: "gaming" })],
        manualSites: ["news.com"]
    });

    commit(app, { categories: [], manualSites: [] });
    commit(app, { categories: [category({ id: "gaming" })] });

    reconcile(app, chrome);

    eq(ids(chrome), ["gaming"], "the reinstated category did not survive, or the removed one did");
    eq(chrome.fortress.manualSites, [], "an unrelated removal was held up by the reversal");
});

it("11. a plain disagreement, with no record, never takes a defence down", () => {
    const app = peer("app", { categories: [category({ id: "social", enabled: true })] });
    const chrome = peer("chrome", { categories: [category({ id: "social", enabled: false })] });
    chrome.rev = 9;

    reconcile(app, chrome);

    eq(app.fortress.categories[0].enabled, true,
        "a defence came down with nobody deciding to");
});

// ===========================================================================
describe("Replaying, forever");

it("12. reconciling a settled state changes nothing, however many times", () => {
    // The reconcile runs on a tick, forever. Anything not idempotent is a bug
    // with a delay on it.
    const app = peer("app", {
        categories: [category({ id: "social" }), category({ id: "gaming" })],
        manualSites: ["news.com"],
        cooldown: { seconds: 600, escalate: true, factor: 2 }
    });
    const chrome = peer("chrome", {
        categories: [category({ id: "social" }), category({ id: "gaming" })],
        manualSites: ["news.com"],
        cooldown: { seconds: 600, escalate: true, factor: 2 }
    });

    commit(app, { categories: [category({ id: "gaming" })], manualSites: [] });
    commit(app, { cooldown: { seconds: 120, escalate: true, factor: 2 } });

    const first = JSON.stringify(reconcile(app, chrome));
    for (let i = 0; i < 5; i += 1) {
        eq(JSON.stringify(reconcile(app, chrome)), first, `tick ${i + 2} changed a settled fortress`);
    }

    eq(ids(chrome), ["gaming"]);
    eq(chrome.fortress.cooldown.seconds, 120);
});

it("13. records are pruned to the last fifty, newest kept", () => {
    const records = [];
    for (let i = 1; i <= 60; i += 1) {
        records.push({ rev: i, at: i, device: "app", categoriesRemoved: ["c" + i] });
    }

    const list = S.normalizeAuthoredList(records);

    eq(list.length, 50, "the list grew without bound");
    eq(list[0].rev, 11, "pruning kept the oldest rather than the newest");
    eq(list[49].rev, 60);
});

it("14. a record written before 1.12 upgrades into the list", () => {
    // 1.11 stored one record in a slot of its own, with no device and no id. A
    // fortress upgrading brings its last weakening with it rather than dropping
    // it mid-sync.
    const legacy = { rev: 4, at: 1700000000000, categoriesRemoved: ["social"] };
    const list = S.normalizeAuthoredList(legacy);

    eq(list.length, 1, "the record from 1.11 was dropped on upgrade");
    eq(list[0].categoriesRemoved, ["social"]);
    eq(list[0].id, "legacy:4:1700000000000",
        "a record with no device got an id two peers could collide on");
});

// ===========================================================================
describe("Through the whole merge");

it("15. mergePeerState carries the records rather than consuming them", () => {
    const base = {
        today: "2026-09-09",
        events: [], counters: {}, stats: {}, dayLog: {},
        seal: null, sealAttempts: null, escalation: {}, tempUnlocks: {}
    };

    const app = peer("app", { categories: [category({ id: "social" })] });
    commit(app, { categories: [] });

    const merged = S.mergePeerState(
        Object.assign({}, base, {
            fortressRev: 0,
            authored: [],
            fortress: { categories: [category({ id: "social" })], manualSites: [], task: null, cooldown: null }
        }),
        Object.assign({}, base, {
            fortressRev: app.rev,
            authored: app.authored,
            fortress: app.fortress
        }),
        Date.now()
    );

    eq(merged.fortress.categories, [], "the removal did not cross the whole merge");
    eq(merged.authored.length, 1, "the record was consumed instead of kept");
    eq(merged.authored[0].device, "app");
});

it("16. the record's id is the same string on both peers", () => {
    // Without this the union keeps re-adding the same weakening under a new
    // name, and the holder check never finds anyone holding it.
    const app = peer("app", { categories: [category({ id: "social" })] });
    const chrome = peer("chrome", { categories: [category({ id: "social" })] });

    commit(app, { categories: [] });
    const written = app.authored[0].id;

    reconcile(app, chrome);

    eq(chrome.authored.map((r) => r.id), [written], "the peer renamed the record it adopted");
    eq(written, "app:1", "the id is not device:rev");
});

// ---- Report ---------------------------------------------------------------
//
// The harness awaits each case, so the report waits for the queue to drain even
// though nothing here is actually asynchronous.

Promise.resolve().then(() => process.exit(report("authored") ? 1 : 0));
