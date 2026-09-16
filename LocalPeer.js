// LocalPeer.js — the extension's client for the desktop app.
//
// Sync.js holds the merge rules and knows nothing about how a peer is reached.
// This is the transport it was left a seam for: it finds the desktop app on
// loopback, pairs with it once, and hands it this fortress on every tick.
//
// The protocol is specified in desktop/SYNC-PROTOCOL.md. Read that first — the
// security decisions are argued there rather than here.
//
// Dependency-free classic script, same contract as the rest of the shared
// layer: top-level declarations only, nothing touching storage or the DOM at
// load time, safe under importScripts() in the service worker.
//
// ---------------------------------------------------------------------------
// Design note — this must never be able to make the gate weaker
//
// Every failure here resolves rather than rejects, and resolves to "no peer".
// The app being closed, crashed, uninstalled, holding a busy port or answering
// with nonsense must all look identical to the extension: nothing to sync
// with, carry on. The extension holds its own enforceable copy of every rule
// and blocks without consulting anyone.
//
// That rule is what makes the second half of the exchange safe. The merge runs
// here — see the section on where the merge runs in SYNC-PROTOCOL.md — and the
// result is committed back to the app afterwards. A commit the app refuses, or
// never arrives at, costs a tick. It never costs the gate.

// Where we last found the app, and what it gave us to prove who we are.
// Shape: { port, token, protocol, pairedAt }
const LOCAL_PEER_KEY = "localPeer";

// The app binds the first free port in this range. It cannot tell us which one
// — an extension cannot read a file — so we walk it once and remember.
const PEER_PORTS = [47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830, 47831, 47832];

const PEER_PROTOCOL = 2;

// Loopback should answer immediately or not at all. A long timeout here would
// stall the alarm tick behind a port that is open but silent.
const PEER_TIMEOUT_MS = 1500;

function peerUrl(port, path) {
    return `http://127.0.0.1:${port}/dominus/v1/${path}`;
}

function loadLocalPeer() {
    return new Promise((resolve) => {
        chrome.storage.local.get([LOCAL_PEER_KEY], (result) => {
            const stored = result[LOCAL_PEER_KEY] || {};
            resolve({
                port: Number(stored.port) || null,
                token: stored.token ? String(stored.token) : null,
                protocol: Number(stored.protocol) || null,
                pairedAt: Number(stored.pairedAt) || 0
            });
        });
    });
}

function saveLocalPeer(peer) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [LOCAL_PEER_KEY]: peer }, () => resolve(peer));
    });
}

// Every request goes through here so nothing can hang the tick and nothing can
// throw past it. Resolves the parsed body, or null for any failure at all.
function peerFetch(port, path, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);

    return fetch(peerUrl(port, path), Object.assign({ signal: controller.signal }, options))
        .then((response) => response.json()
            .then((body) => ({ status: response.status, body }))
            .catch(() => ({ status: response.status, body: null })))
        .catch(() => null)
        .then((result) => {
            clearTimeout(timer);
            return result;
        });
}

// Is the thing on this port actually Dominus?
//
// The signature check matters: any local process can hold a port in the range,
// and posting a fortress to whatever answers would be handing the record to
// something we never identified.
function peerHello(port) {
    return peerFetch(port, "hello", { method: "GET" }).then((result) => {
        if (!result || result.status !== 200) return null;
        const body = result.body || {};
        if (body.app !== "dominus") return null;
        return {
            port: port,
            protocol: Number(body.protocol) || 0,
            version: String(body.version || ""),
            paired: body.paired === true
        };
    });
}

// Walks the range until something answers. Sequential rather than parallel:
// ten simultaneous connections to find one app is rude on a machine that is
// meant not to notice this running.
function findLocalPeer() {
    return loadLocalPeer().then((peer) => {
        const ordered = peer.port
            ? [peer.port].concat(PEER_PORTS.filter((p) => p !== peer.port))
            : PEER_PORTS.slice();

        const walk = (index) => {
            if (index >= ordered.length) return Promise.resolve(null);
            return peerHello(ordered[index])
                .then((found) => found || walk(index + 1));
        };

        return walk(0);
    });
}

// ---- Pairing --------------------------------------------------------------

// Exchanges a code the user read off the app's window for a device token.
//
// Resolves { paired: true } or { paired: false, reason }. The reason is shown
// to the user, so it says what to do rather than what went wrong internally.
function pairWithLocalPeer(code) {
    if (!code || !String(code).trim()) {
        return Promise.resolve({ paired: false, reason: "Enter the code shown in the app." });
    }

    return Promise.all([findLocalPeer(), ensureDevice()]).then(([found, device]) => {
        if (!found) {
            return {
                paired: false,
                reason: "Couldn't find Dominus for the desktop. Is it running?"
            };
        }

        if (found.protocol !== PEER_PROTOCOL) {
            // Guessing at a payload shape across a protocol change is how two
            // peers corrupt each other. Refuse and say which side is behind.
            return {
                paired: false,
                reason: found.protocol > PEER_PROTOCOL
                    ? "The desktop app is newer than this extension. Update the extension."
                    : "The desktop app is older than this extension. Update the app."
            };
        }

        return peerFetch(found.port, "pair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                code: String(code).trim().toUpperCase(),
                device: device.id,
                name: "Chrome extension"
            })
        }).then((result) => {
            if (!result) {
                return { paired: false, reason: "The app stopped answering. Try again." };
            }

            if (result.status !== 200 || !result.body || !result.body.token) {
                return {
                    paired: false,
                    reason: "That code wasn't accepted. Ask the app for a new one."
                };
            }

            return saveLocalPeer({
                port: found.port,
                token: result.body.token,
                protocol: found.protocol,
                pairedAt: Date.now()
            }).then(() => ({ paired: true, port: found.port }));
        });
    });
}

// Forgets the app. The app keeps its own device list; this is only this side.
function unpairLocalPeer() {
    return saveLocalPeer({ port: null, token: null, protocol: null, pairedAt: 0 });
}

function localPeerStatus() {
    return loadLocalPeer().then((peer) => ({
        paired: Boolean(peer.token),
        port: peer.port,
        pairedAt: peer.pairedAt
    }));
}

// ---- The transport --------------------------------------------------------

// Everything that carries the device token, which is every request but hello.
function peerPost(port, path, token, body) {
    return peerFetch(port, path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            // The custom header is load-bearing: it forces a CORS preflight for
            // anything that is not this extension, which is what keeps web
            // pages away from a service that can be written to.
            "X-Dominus-Token": token
        },
        body: JSON.stringify(body)
    });
}

// Handed to setSyncTransport(). Posts this fortress, and resolves either null —
// nothing to sync with — or { state, commit } for syncNow() to merge and hand
// the answer back to.
function localPeerTransport(mine) {
    return loadLocalPeer().then((peer) => {
        if (!peer.token) return null;

        // Tracks the port the exchange actually reached, so the commit goes to
        // the same app rather than to whatever the stored port happens to be by
        // the time the merge is done.
        let port = peer.port;

        const send = (at) => peerPost(at, "sync", peer.token, mine);

        return send(port).then((result) => {
            // The app moved ports (restarted while another program held the old
            // one). Find it again, once, rather than going quiet until the user
            // notices.
            if (result) return result;

            return findLocalPeer().then((found) => {
                if (!found || found.port === port) return null;
                port = found.port;
                return saveLocalPeer(Object.assign({}, peer, { port: port }))
                    .then(() => send(port));
            });
        }).then((result) => {
            if (!result) return null;

            if (result.status === 401) {
                // The app no longer recognises us — revoked, or its store was
                // reset. Drop the token rather than retrying a credential that
                // is gone; the user pairs again when they choose to.
                return unpairLocalPeer().then(() => null);
            }

            const body = (result.status === 200 && result.body) ? result.body : null;
            if (!body) return null;

            // A protocol this extension does not speak is refused rather than
            // guessed at. Pairing checks the same number, but an app can be
            // updated underneath a pairing that already exists — and merging
            // against a payload shape neither side agreed on is how two peers
            // corrupt each other.
            if (Number(body.protocol) !== PEER_PROTOCOL) return null;

            return {
                // null on an app that has never held a state. syncNow() reads
                // that as nothing to merge and simply hands ours over.
                state: body.state || null,
                commit: (merged) => commitToLocalPeer(port, peer.token, body.stateRev, merged)
            };
        });
    });
}

// Hands the merged result back. Resolves true if the app took it.
//
// A refusal is not an error and is not retried inside the tick: 409 means the
// user edited something in the app's own window while this merge was being
// computed, so the merge did not see it. The next tick reads the newer state
// and merges against that, which is a minute — where retrying against a state
// that may move again is a loop rather than a fix.
function commitToLocalPeer(port, token, stateRev, merged) {
    return peerPost(port, "commit", token, {
        stateRev: Number(stateRev) || 0,
        state: merged
    }).then((result) => Boolean(result) && result.status === 200);
}

// Installed at load. syncNow() then finds a transport instead of resolving
// "no-peer", and the alarm tick in Background.js starts reaching for the app.
if (typeof setSyncTransport === "function") {
    setSyncTransport(localPeerTransport);
}
