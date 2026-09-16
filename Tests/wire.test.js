// Tests/wire.test.js — the round trip, end to end.
//
//     node Tests/wire.test.js
//
// Everything else tests one side. This tests the exchange: readPeerState() on
// the wire, the merge, and the commit back — through the real LocalPeer.js,
// with only `fetch` replaced.
//
// The app on the other end is a stand-in, but it is a faithful one: the same
// two endpoints, the same compare-and-set, the same status codes, checked
// against the Rust that serves them in service.rs's own tests. What is being
// proved here is the half that runs in the browser — that a defence taken down
// in the app crosses, that one taken down in the browser crosses back, and that
// neither side loses a block it did not mean to.
//
// See desktop/SYNC-PROTOCOL.md for why the merge runs in one place.

const { loadSharedLayer, createHarness } = require("./load.js");

const { describe, it, eq, ok, report } = createHarness();

// ---- A stand-in for the desktop app ---------------------------------------
//
// Holds a state behind a revision counter and refuses a commit computed against
// a revision it has moved past. That is the whole of what the Rust side does
// with a fortress — it has no merge rules of its own.

function createApp(over) {
    return Object.assign({
        protocol: 2,
        token: "device-token",
        state: null,
        stateRev: 0,
        // Every request the app was asked, in order, so a test can say what
        // did and did not go over the wire.
        seen: [],
        // Called after /sync and before /commit, which is the window in which
        // the user can edit something in the app that the merge did not see.
        onSync: null
    }, over || {});
}

function createFetch(app) {
    return function fetchStub(url, options) {
        const path = String(url).split("/dominus/v1/")[1];
        const headers = (options && options.headers) || {};
        const body = options && options.body ? JSON.parse(options.body) : null;

        app.seen.push(path);

        const answer = (status, payload) => Promise.resolve({
            status: status,
            json: () => Promise.resolve(payload)
        });

        if (path === "hello") {
            return answer(200, { app: "dominus", protocol: app.protocol, version: "0.1.0", paired: true });
        }

        if (headers["X-Dominus-Token"] !== app.token) {
            return answer(401, { error: "unpaired" });
        }

        if (path === "sync") {
            const reply = answer(200, {
                protocol: app.protocol,
                stateRev: app.stateRev,
                state: app.state
            });
            if (app.onSync) app.onSync();
            return reply;
        }

        if (path === "commit") {
            if (body.stateRev !== app.stateRev) {
                return answer(409, { error: "stale", stateRev: app.stateRev });
            }
            app.state = body.state;
            app.stateRev += 1;
            return answer(200, { stateRev: app.stateRev });
        }

        return answer(404, {});
    };
}

// ---- A browser -------------------------------------------------------------

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

// A loaded extension, paired with `app`, holding `fortress` already.
//
// Seeded into storage rather than committed, because a fixture is a fortress
// that already exists — committing it would author records for the difference
// from a default fortress, and every test here counts records.
async function browser(app, fortress) {
    const loaded = loadSharedLayer({ fetch: createFetch(app) });
    const { scope, store } = loaded;

    store.localPeer = { port: 47823, token: app.token, protocol: 2, pairedAt: 1 };

    const held = Object.assign(
        { categories: [], manualSites: [], task: null, cooldown: null },
        fortress || {}
    );

    store.categoryDefs = held.categories;
    store.manualSites = held.manualSites;
    store.unlockTask = held.task;
    store.blockedSites = scope.computeBlockedSites(held.categories, held.manualSites);

    return loaded;
}

const siteOf = (state) => ((state.fortress || {}).categories || []).map((c) => c.id);

async function run() {

// ===========================================================================
    describe("The exchange");

    await it("an app holding nothing is simply handed this fortress", async () => {
        const app = createApp();
        const { scope, store } = await browser(app, {
            categories: [category({ id: "social" })],
            manualSites: ["news.com"]
        });

        const outcome = await scope.syncNow();

        eq(outcome.status, "sent", "the first sync did not hand anything over");
        eq(app.seen, ["sync", "commit"], "the exchange was not two steps");
        eq(app.stateRev, 1);
        eq(siteOf(app.state), ["social"], "the app did not receive the fortress");
        eq(app.state.fortress.manualSites, ["news.com"]);
        ok(app.state.today, "the committed state cannot say which day it is");

        // And nothing about the exchange disturbed what the browser enforces.
        eq(store.blockedSites.sort(), ["news.com", "x.com"]);
    });

    await it("a defence taken down in the app crosses to the browser", async () => {
        // The point of Phase 2. Until now this could only go the other way.
        const app = createApp();
        const { scope, store } = await browser(app, {
            categories: [category({ id: "social" }), category({ id: "gaming", sites: ["roblox.com"] })]
        });

        await scope.syncNow();
        eq(siteOf(app.state), ["social", "gaming"]);

        // The app's window removes a category: the same describeAuthoredWeakening()
        // the extension runs, against the same state, stamped and stored.
        const before = app.state.fortress;
        const after = Object.assign({}, before, {
            categories: before.categories.filter((c) => c.id !== "gaming")
        });

        app.state = Object.assign({}, app.state, {
            fortress: after,
            fortressRev: app.state.fortressRev + 1,
            authored: (app.state.authored || []).concat([Object.assign(
                { rev: app.state.fortressRev + 1, at: Date.now(), device: "desktop" },
                scope.describeAuthoredWeakening(before, after)
            )])
        });
        app.stateRev += 1;

        const outcome = await scope.syncNow();

        eq(outcome.status, "merged");
        eq(outcome.committed, true, "the browser did not hand the merge back");
        eq(store.categoryDefs.map((c) => c.id), ["social"],
            "a category removed in the app did not come down in the browser");
        eq(store.blockedSites, ["x.com"], "what is enforced still holds the removed site");
        eq(siteOf(app.state), ["social"], "the app did not end up on the merged state");
    });

    await it("a defence taken down in the browser crosses to the app", async () => {
        const app = createApp();
        const { scope } = await browser(app, {
            categories: [category({ id: "social" }), category({ id: "gaming", sites: ["roblox.com"] })]
        });

        await scope.syncNow();

        await scope.commitFortress({ categories: [category({ id: "social" })] });
        await scope.syncNow();

        eq(siteOf(app.state), ["social"], "the removal did not reach the app");
        eq(app.state.authored.length, 1, "the app was not told why the category went");
    });

    await it("both sides removing at once loses neither removal", async () => {
        // Two peers each taking something down is the case the first weakening
        // design got wrong in both directions at once. Through the real wire.
        const app = createApp();
        const { scope, store } = await browser(app, {
            categories: [
                category({ id: "social" }),
                category({ id: "gaming", sites: ["roblox.com"] })
            ]
        });

        await scope.syncNow();

        // The app drops gaming.
        const before = app.state.fortress;
        const after = Object.assign({}, before, { categories: before.categories.filter((c) => c.id !== "gaming") });
        app.state = Object.assign({}, app.state, {
            fortress: after,
            fortressRev: app.state.fortressRev + 1,
            authored: (app.state.authored || []).concat([Object.assign(
                { rev: app.state.fortressRev + 1, at: Date.now(), device: "desktop" },
                scope.describeAuthoredWeakening(before, after)
            )])
        });
        app.stateRev += 1;

        // The browser, not yet knowing, drops social.
        await scope.commitFortress({ categories: [category({ id: "gaming", sites: ["roblox.com"] })] });

        await scope.syncNow();

        eq(store.categoryDefs, [], "one of the two removals was lost in the browser");
        eq(siteOf(app.state), [], "one of the two removals was lost in the app");
        eq(store.blockedSites, [], "something is still being enforced that both sides took down");
    });

// ===========================================================================
    describe("When the exchange goes wrong");

    await it("an edit in the app while the merge runs refuses the commit, and costs a tick", async () => {
        const app = createApp();
        const { scope, store } = await browser(app, { categories: [category({ id: "social" })] });

        await scope.syncNow();

        // The user edits something in the app's window between /sync and /commit.
        app.onSync = () => {
            app.stateRev += 1;
            app.onSync = null;
        };

        const outcome = await scope.syncNow();

        eq(outcome.status, "merged", "the browser did not write its own merge");
        eq(outcome.committed, false, "a commit against a moved state was accepted");

        // The browser still applied the merge — what it enforces is never left
        // waiting on the app agreeing to anything.
        ok(store.blockedSites.includes("x.com"), "the gate was weakened by a refused commit");

        // And the next tick lands.
        const again = await scope.syncNow();
        eq(again.committed, true, "the retry was refused too");
    });

    await it("a revoked pairing drops the token instead of retrying it", async () => {
        const app = createApp({ token: "the-real-one" });
        const { scope, store } = await browser(app, { categories: [category({ id: "social" })] });

        store.localPeer = { port: 47823, token: "revoked", protocol: 2, pairedAt: 1 };

        eq(await scope.syncNow(), { status: "no-peer" });
        eq(store.localPeer.token, null, "a credential the app has forgotten was kept");

        // And it stops sending, rather than knocking once a minute forever.
        app.seen = [];
        eq(await scope.syncNow(), { status: "no-peer" });
        eq(app.seen, [], "an unpaired extension went on knocking");
    });

    await it("an app speaking a protocol this extension does not is refused", async () => {
        // Merging against a payload shape neither side agreed on is how two peers
        // corrupt each other.
        const app = createApp({ protocol: 3, state: { fortress: { categories: [] } } });
        const { scope, store } = await browser(app, { categories: [category({ id: "social" })] });

        eq(await scope.syncNow(), { status: "no-peer" });
        eq(store.categoryDefs.map((c) => c.id), ["social"], "a fortress was merged across a protocol change");
        eq(app.seen, ["sync"], "it committed to an app it could not understand");
    });

    await it("an app that is not there costs nothing at all", async () => {
        const app = createApp();
        const dead = () => Promise.reject(new Error("ECONNREFUSED"));
        const loaded = loadSharedLayer({ fetch: dead });
        loaded.store.localPeer = { port: 47823, token: app.token, protocol: 2, pairedAt: 1 };

        await loaded.scope.commitFortress({
            categories: [category({ id: "social" })], manualSites: [], task: null, cooldown: null
        });

        eq(await loaded.scope.syncNow(), { status: "no-peer" });
        eq(loaded.store.blockedSites, ["x.com"], "an unreachable app changed what is enforced");
    });

    process.exit(report("wire") ? 1 : 0);
}

run();
