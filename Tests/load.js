// Tests/load.js — loads the extension's shared layer into a plain Node context.
//
// Sync.js and its dependencies are dependency-free classic scripts that declare
// everything at the top level and touch nothing at load time. That contract is
// what lets the service worker pull them in with importScripts(), and it is the
// same thing that makes this possible: concatenate them into one context, the
// way a page does, and call the functions directly.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The shared layer, plus Backup.js. The first five are the worker-safe set
// Background.js pulls in with importScripts; Backup.js is a page script and
// registers a DOMContentLoaded listener at load, which is why the context below
// carries a minimal `document`.
const FILES = ["Tasks.js", "Categories.js", "Stats.js", "Seal.js", "Sync.js", "Backup.js"];

function loadSharedLayer() {
    const root = path.join(__dirname, "..");

    // An in-memory chrome.storage.local, faithful to the callback API the
    // extension actually uses. The merge rules are pure and never reach it; the
    // recording path does, and that is the path that runs on every stand and
    // every unlock.
    const store = {};

    const local = {
        get(keys, done) {
            const out = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
                if (key in store) out[key] = clone(store[key]);
            });
            // Asynchronous on purpose. A stub that calls back synchronously
            // hides exactly the interleaving the serialized queues exist to
            // prevent, which would make the race tests pass for the wrong
            // reason.
            setTimeout(() => done(out), 0);
        },
        set(items, done) {
            Object.keys(items).forEach((key) => {
                store[key] = clone(items[key]);
            });
            setTimeout(() => done && done(), 0);
        }
    };

    let ids = 0;

    const context = {
        chrome: {
            storage: { local: local },
            runtime: { getManifest: () => ({ version: "1.11" }) }
        },
        crypto: { randomUUID: () => `uuid-${++ids}` },
        setTimeout: setTimeout,
        console: console,
        module: { exports: {} },

        // Enough document for a page script to register its load listener and
        // find no panel to wire. Nothing under test touches the DOM beyond
        // that — if something starts to, this stub will say so loudly rather
        // than silently passing.
        document: {
            addEventListener() {},
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        }
    };

    vm.createContext(context);

    FILES.forEach((file) => {
        vm.runInContext(
            fs.readFileSync(path.join(root, file), "utf8"),
            context,
            { filename: file }
        );
    });

    return {
        // What Sync.js exports for testing: the pure rules.
        api: context.module.exports,
        // The shared global scope, which is how the extension itself reaches
        // these functions — so it is how the tests reach the impure ones.
        scope: context,
        store: store
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// ---- A very small harness -------------------------------------------------

function createHarness() {
    const failures = [];
    let passed = 0;
    let group = "";

    function describe(name) {
        group = name;
    }

    async function it(name, fn) {
        try {
            await fn();
            passed += 1;
        } catch (error) {
            failures.push({ name: `${group} — ${name}`, message: error.message });
        }
    }

    function eq(actual, expected, note) {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        if (a !== b) {
            throw new Error(`${note || "mismatch"}\n      expected ${b}\n      actual   ${a}`);
        }
    }

    function ok(value, note) {
        if (!value) throw new Error(note || "expected truthy");
    }

    function report(title) {
        console.log("");
        failures.forEach((failure) => {
            console.log(`  FAIL  ${failure.name}`);
            console.log(`        ${failure.message}\n`);
        });
        console.log(`  ${title}: ${passed} passed, ${failures.length} failed\n`);
        return failures.length;
    }

    return { describe, it, eq, ok, report };
}

module.exports = { loadSharedLayer, createHarness };
