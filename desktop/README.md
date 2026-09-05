# Dominus for the desktop

The keep. The extension keeps the gate — it is the only thing that can see a
navigation and stop it — and this holds everything the browser cannot reach:
limits on applications rather than sites, schedules, the full record, and later
the community servers.

**Status: Phase 1, in progress.** The window and its shell exist; the Rust side
does not yet. See `SYNC-PROTOCOL.md` for how the two halves will find each
other and what they exchange.

---

## Why it lives in this repository

Because `Styles/Tokens.css` at the repository root is the only place a colour is
defined, and both surfaces have to read it. In a separate repository that file
would be copied by hand, and the copies would drift — which is the exact thing
the token file was created to prevent.

The merge rules in `Sync.js` have the same property: this app has to apply them
identically, and keeping the two adjacent makes any divergence visible in a
diff rather than discoverable in the field.

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
    app.js              shell, routing, pairing
    styles/
      app.css
      tokens.css        GENERATED — do not edit
    assets/
      crest.png         GENERATED — do not edit
  tools/
    sync-shared.mjs     copies the tokens and the crest in from the root
  src-tauri/            the Rust side (not created yet)
```

`tokens.css` and `crest.png` are copies, generated and gitignored. Tauri bundles
only what is under the frontend directory, so `../../Styles/Tokens.css` would
resolve in a dev server and then vanish from the packaged app.

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

Then, for Phase 1: the tray, autostart and single-instance plugins, and the
loopback service from `SYNC-PROTOCOL.md` behind the two commands the window
already calls — `service_status` and `new_pairing_code`.
