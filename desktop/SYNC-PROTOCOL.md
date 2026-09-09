# The local sync protocol

How the Chrome extension and the desktop app find each other, agree that they
are talking to the right peer, and exchange a fortress.

Written before either side implements it, because the security decisions here
are the kind that are hard to change once two versions are in the wild.

Status: **protocol 2, implemented on both sides.** Protocol 1 was Phase 1's
read-only mirror: the extension posted its fortress and the app answered
`{ accepted: true }`. Protocol 2 makes the exchange bidirectional, and changes
what `/sync` answers with — which is a change of meaning, so the number moved.

---

## Why HTTP on loopback

Not **native messaging**: Chrome spawns a native host as a child process, so
the long-lived GUI app cannot *be* the host — it would need a relay and a
second IPC hop. It also pins the extension ID in a per-browser registry
manifest, so unpacked and store builds need different installs, and it only
ever works for Chrome.

Not a **live socket**: MV3 terminates the service worker after ~30 seconds
idle. Any design that assumes a persistent connection from the extension is
designing against the platform.

So: a small HTTP server in the desktop app, on `127.0.0.1`, which the extension
calls after every local write and on a `chrome.alarms` tick. Request and
response, nothing to reconnect. Correctness never depends on the app running,
the browser being open, or the machine being online — the two peers are
usually out of contact and occasionally reconcile.

`<all_urls>` in the extension manifest already covers `http://127.0.0.1/*`, so
no new host permission is needed.

---

## Finding the port

The app binds the first free port in **47823–47832**. It cannot use a fixed
port, because another program may hold it; it cannot write the port somewhere
the extension reads, because an extension cannot read the filesystem.

So the extension probes. On each attempt it walks the range calling `hello`
until something answers with the Dominus signature, then **caches that port**
in `chrome.storage.local` and goes straight there next time. It only re-probes
when the cached port stops answering.

Ten probes happen once per app restart, not once per tick.

---

## Trusting the peer

Any local process can bind a port in that range and claim to be Dominus. Any
web page the user has open can also `fetch()` loopback addresses. Three things
together handle that, and none is sufficient alone.

### 1. A pairing code the human carries

The app displays a **six-character code**. The user types it into the
extension. The extension posts it to `pair`, and gets back a long-lived
**device token**.

This is what a port-squatter cannot fake: it does not know the code, because
the code only exists on the real app's screen. It is also what makes pairing an
explicit act rather than something that silently happens to whatever answers.

A code is valid for **five minutes** and for **one** successful pairing. The
app shows a fresh one whenever the pairing screen is opened.

### 2. A custom header on every request

Every request carries `X-Dominus-Token`. A custom header makes the request
non-simple, so the browser must send a CORS **preflight** first — and the
server answers the preflight only for the extension's own origin.

This is the part that shuts out web pages. CORS would stop a page *reading* the
response, but a simple `POST` still arrives and is still processed, and reading
nothing back is no comfort when the damage is a write. Forcing a preflight
means the handler is never reached at all.

### 3. Loopback only

The listener binds `127.0.0.1`, never `0.0.0.0`. Nothing on the network can
reach it, only this machine.

### What this does not defend against

Another program running as the user, on this machine, that reads the token out
of the app's config file. That is the same trust boundary as everything else
Dominus does: `chrome.storage.local` is readable from DevTools, and the
extension can be removed in two clicks. The protocol is not trying to be
stronger than the product — see the honesty note on the seal panel.

---

## Endpoints

All under `/dominus/v1/`. All request and response bodies are JSON.

### `GET /hello`

Unauthenticated. The only endpoint that is.

```json
{ "app": "dominus", "protocol": 2, "version": "0.1.0", "paired": true }
```

`app: "dominus"` is the signature the port probe matches on. `paired` tells the
extension whether it needs to send the user to the pairing screen.

A response missing the signature means something else holds the port; the
extension moves on to the next one.

### `POST /pair`

```json
{ "code": "K7M2QP", "device": "<extension deviceId>", "surface": "extension" }
```

→ `200` `{ "token": "<64 hex chars>", "device": "<app deviceId>" }`
→ `403` `{ "error": "bad-code" }` — wrong, expired, or already used

The extension stores the token beside its own device identity. The app stores
the extension's `deviceId` in its device list, which is what makes "paired
devices" something the user can see and revoke.

Failed attempts are rate-limited to **five per minute**, then the code is
discarded and a new one shown. A six-character code is only worth anything if
it cannot be guessed at speed.

### `POST /sync`

Requires `X-Dominus-Token`. The body is exactly the shape `readPeerState()`
returns in `Sync.js`:

```
{ today, events, counters, fortressRev, authored,
  stats, dayLog, fortress, seal, sealAttempts, escalation, tempUnlocks }
```

→ `200` `{ "protocol": 2, "stateRev": 7, "state": { …the same shape… } }`

`state` is `null` on an app that has never held one — a first pairing, or a
fresh install. `stateRev` is not `fortressRev`: it counts writes to the app's
copy, and exists only so the commit below can tell whether that copy moved
underneath the merge.

`blockedSites` is absent from that shape on purpose. It is a cache of the
categories and the manual list, and a peer that took it at face value could
enforce a list its own categories disagree with. Each side re-derives it.

→ `401` `{ "error": "unpaired" }` — token unknown or revoked. The extension
clears its token and stops sending until the user pairs again.

### `POST /commit`

Requires `X-Dominus-Token`.

```json
{ "stateRev": 7, "state": { "…": "the merged result" } }
```

→ `200` `{ "stateRev": 8 }`
→ `409` `{ "error": "stale", "stateRev": 9 }` — the app's copy moved while the
merge was being computed. Nothing is written. The extension does not retry
inside the tick; the next one reads the newer state and merges against that.

---

## Where the merge runs, and why only in one place

`mergePeerState()` is around six hundred lines of rules that took thirteen
scenarios to get right. The obvious design — each peer merges its own copy —
means writing all of it a second time in Rust and keeping the two in step by
hand, forever. That is the exact failure `Styles/Tokens.css` is copied at build
time to avoid, on a file where the cost of drift is a wrong colour rather than a
defence that quietly stopped being enforced.

So the merge runs **once, in the extension**, and the app is handed the result:

```
POST /sync    { mine }              -> { stateRev: 7, state: theirs }
              merged = mergePeerState(mine, theirs)
              applyMerge(merged)                    (the extension writes)
POST /commit  { stateRev: 7, merged } -> { stateRev: 8 }   (the app writes)
```

Both peers land on the same state because it is the same object, not because
two implementations agreed. The Rust side holds JSON and a counter and has no
merge logic at all.

The compare-and-set is what makes this safe against the app editing its own
fortress in between: if `stateRev` moved, the commit is refused and nothing is
written. The extension loses a tick, which is a minute.

### What the app is trusting the extension with

That the thing it is handed is really the merge of what it sent. A paired
extension could commit anything.

This is a smaller grant than it looks. `mergePeerState()` is strengthen-wins:
the only thing in a committed state that can take a defence down is an authored
record, and an authored record is written on the far side of the seal. An
extension that wanted to weaken a fortress does not need this endpoint — it is
the extension, it holds the enforceable copy, and the user can remove it in two
clicks. The protocol is not trying to be stronger than the product.

What the app does **not** do is accept a commit as an instruction it then acts
on independently. It stores it. Phase 3, where the app starts enforcing limits
on applications rather than mirroring the browser, is where that stops being
free — and is where this section will need arguing again.

### Authoring, on the app's side

Editing a category in the app is not a merge; it is a commit, and it happens
with the window open. So it runs in the window, in JavaScript, against a copy of
`Sync.js` that `tools/sync-shared.mjs` brings in at build time — the same
mechanism, and the same argument, as `Tokens.css`. The window works out the
authored record with `describeAuthoredWeakening()`, raises `fortressRev`, and
hands Rust the whole new state through the `put_state` command.

The app therefore has no merge rules and no authoring rules of its own. Every
rule in the system is written once, in `Sync.js`.

---

## What the extension does when the app is not there

Nothing. `syncNow()` resolves `{ status: "no-peer" }` and the tick moves on.

The extension holds its own enforceable copy of every rule and never waits on a
peer to decide whether to block something. This is the property that matters
most in the whole design: the app being closed, crashed, uninstalled or
unreachable must never make the gate weaker.

---

## Versioning

`protocol: 2` in `hello`. A peer that sees a protocol number it does not
understand refuses to sync and says so, rather than guessing at a payload
shape. Adding optional fields does not bump it; changing the meaning of an
existing one does.

Protocol 1 answered `/sync` with `{ accepted: true }` and had no `/commit`. An
extension still speaking 1 is refused at pairing with a message naming which
side is behind, which is the whole reason the number is in `hello` rather than
discovered halfway through an exchange.
