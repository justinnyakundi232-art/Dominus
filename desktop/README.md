# Dominus for the desktop

The keep. The extension keeps the gate — it is the only thing that can see a
navigation and stop it — and this holds everything the browser cannot reach:
limits on applications rather than sites, schedules, the full record, and later
the community servers.

**Status: Phase 2.** The window, the tray, the loopback service and pairing all
work, and syncing is bidirectional — The Fortress here edits categories, and the
edit reaches the browser on its next tick. See `SYNC-PROTOCOL.md` for how the
two halves find each other and what they exchange.

Not built yet: limits on applications rather than sites, which is Phase 3 and
the actual reason to install this.

---

## Why it lives in this repository

Because `Styles/Tokens.css` at the repository root is the only place a colour is
defined, and both surfaces have to read it. In a separate repository that file
would be copied by hand, and the copies would drift — which is the exact thing
the token file was created to prevent.

The merge rules in `Sync.js` have the same property, and the answer went one
step further than adjacency: this app does not have its own copy of them at all.
`tools/sync-shared.mjs` copies `Sync.js` itself into `src/shared/` at build time,
the window loads it, and the merge runs in exactly one implementation. The
argument is in `SYNC-PROTOCOL.md` under *Where the merge runs*.

The extension's package is unaffected. `build.py` decides what ships by
following references out of `manifest.json`, and nothing in the extension
references `desktop/`, so it is excluded without anyone having to remember.

---

## Layout

```
desktop/
  SYNC-PROTOCOL.md      how the two halves talk — read this first
  src/                  the window: plain HTML, CSS and JS, no build step
    index.html
    app.js              shell, routing, pairing, the fortress editor
    styles/
      app.css
      tokens.css        GENERATED — do not edit
    shared/             GENERATED — do not edit
      sync.js           the merge and authoring rules, verbatim
      categories.js
      tasks.js
    assets/
      crest.png         GENERATED — do not edit
  tools/
    sync-shared.mjs     copies all of the above in from the repo root
  src-tauri/            the Rust side — window, tray, and the loopback service
    src/
      lib.rs            commands, tray, lifecycle
      service.rs        the HTTP service, and its tests
```

Everything marked GENERATED is a copy, gitignored, with a banner saying so.
Tauri bundles only what is under the frontend directory, so `../../Sync.js`
would resolve in a dev server and then vanish from the packaged app.

---

## Running the window on its own

The shell needs no toolchain — it is plain HTML, and it is how the UI is being
built ahead of the Rust side:

```bash
node desktop/tools/sync-shared.mjs
python .claude/devserver.py 8130
```

Then open `http://localhost:8130/desktop/src/index.html`.

With no Tauri behind it, `service.status()` reports the local service as not
running, and every view shows its unpaired empty state. That is the same path
the real app takes if it cannot bind a port, so it is worth being able to see.

To drive the Fortress editor without a browser extension and a paired app, stub
the bridge before the page loads — `window.__TAURI__.core.invoke` answering
`peer_state` with a fortress and `put_state` by keeping what it is handed. That
is how the editor was checked: the categories render, a typed site is normalised
and added, a removal is authored under `device:rev`, a sealed fortress refuses
every weakening and still accepts a new site, and an edit whose revision has
moved writes nothing.

---

## Bringing up the Rust side

Prerequisites on Windows — WebView2 already ships with Windows 11:

```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```bash
winget install --id Rustlang.Rustup
```

Restart the terminal, then from `desktop/`:

```bash
cargo install tauri-cli --version "^2"
cargo tauri init
```

Answer it:

| Prompt | Answer |
|---|---|
| App name | `Dominus` |
| Window title | `Dominus` |
| Frontend assets, relative to `src-tauri` | `../src` |
| Dev server URL | *(none — the assets are static)* |
| Dev command | *(none)* |
| Build command | *(none)* |

The config is deliberately generated rather than hand-written: Tauri 2's schema
is specific, and a hand-rolled `tauri.conf.json` that has never been compiled is
a bad trade against thirty seconds of `init`.

---

## Tests

```bash
cargo test --lib service
```

Drives the real router through `oneshot`, so what is exercised is the thing that
is served: the round trip, the compare-and-set refusal, an unpaired request, and
a `text/plain` body that must never reach a handler.

The extension's own suites are dependency-free and run with plain `node` from
the repository root — `Tests/wire.test.js` is the one that covers this app,
running the real `LocalPeer.js` against a stand-in for the service here.

---

## Still loose

**Autostart is half-built.** The plugin is registered and never enabled, and
there is no toggle, so the app does not start with the machine. It wants a
control on The Seal rather than being switched on silently.

**The window fetches a webfont from Google.** `src/styles/app.css` imports
Playfair Display over the network, which is a request leaving the machine on
every launch of an app whose Seal panel says your record is "on this machine,
and nowhere else". The font should be bundled or dropped.
