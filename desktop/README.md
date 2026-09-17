# Dominus for the desktop

The keep. The extension keeps the gate — it is the only thing that can see a
navigation and stop it — and this holds everything the browser cannot reach:
limits on applications rather than sites, schedules, the full record, and later
the community servers.

**Status: Phase 3.** The window, the tray, the loopback service and pairing all
work, syncing is bidirectional, and **this app blocks programs**. Add one from
*The Fortress*, and opening it minimizes it and raises the same gate a blocked
site raises — the same task, the same cooldown, and a walk-away or an unlock
recorded against the same streak.

- `SYNC-PROTOCOL.md` — how the two halves find each other and what they exchange.
- `APP-LIMITS.md` — what a program block is, how it is enforced, and why it is
  the mechanic sites already have rather than a daily budget (yet).

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
  APP-LIMITS.md         blocking programs: the design, and what it decided
  src/                  the window: plain HTML, CSS and JS, no build step
    index.html
    app.js              shell, routing, pairing, the fortress editor, the
                        program picker, and what the watcher is told to enforce
    gate.html           the window a blocked program gets you
    gate.js             its task, cooldown and record-keeping
    notice.html         the "few minutes left" reminder, shown without focus
    notice.js
    styles/
      app.css
      gate.css
      notice.css
      tokens.css        GENERATED — do not edit
      campaign.css      GENERATED — the extension's TrackProgress.css
      common.css        GENERATED — the extension's Common.css, for the (?) tips
      fonts/            GENERATED — do not edit
        *.woff2         Playfair Display, so nothing is fetched from Google
        OFL.txt         the licence it has to travel with
    shared/             GENERATED — do not edit
      sync.js           the merge and authoring rules, verbatim
      applications.js   what a program is, and which can never be blocked
      stats.js          standingFrom() and buildDayHistory() for The Campaign
      trackprogress.js  renderCampaign() — the extension's Campaign, verbatim
      categories.js
      tasks.js
    assets/
      crest.png         GENERATED — do not edit
      strategy.png      GENERATED — do not edit
  tools/
    sync-shared.mjs     copies all of the above in from the repo root
  src-tauri/            the Rust side — window, tray, and the loopback service
    src/
      lib.rs            commands, tray, the gate window, the watch loop
      service.rs        the HTTP service, and its tests
      watcher.rs        which program is in front, minimizing it, and the
                        list the picker offers — and its tests
    capabilities/
      default.json      BOTH windows. The gate is told what it is guarding by
                        an event, and a window outside every capability cannot
                        listen for one — its buttons silently stop working.
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
cargo test --lib
```

`service` drives the real router through `oneshot`, so what is exercised is the
thing that is served: the round trip, the compare-and-set refusal, an unpaired
request, and a `text/plain` body that must never reach a handler.

`watcher` covers the decision half of enforcement, which is pure: a blocked
program raises the gate once and not on every poll, leaving and coming back is a
new decision, a live unlock lets it through and an expired one does not, and the
list survives a restart. The Win32 half cannot be unit-tested; it was checked on
the running app through Windows UI Automation — open Notepad, the gate names
it, Notepad is minimized, walk away, twice.

`Tests/applications.test.js`, at the repository root, covers the rest: the
identity rule, the merge, the weakening path, the programs that can never be
blocked, and a program given up from the browser actually being saved.

The extension's own suites are dependency-free and run with plain `node` from
the repository root — `Tests/wire.test.js` is the one that covers this app,
running the real `LocalPeer.js` against a stand-in for the service here.

---

## Building on Windows 11

**Smart App Control blocks a Rust build.** It refuses to run any unsigned
executable it has not seen before, and a build creates dozens — every crate's
build script, and `dominus.exe` itself. The failure looks like this:

```
could not execute process `target\debug\build\...\build-script-build` (never executed)
An Application Control policy has blocked this file
```

A Windows update can switch it on. The only fix for development is turning it
off (Windows Security → App & browser control → Smart App Control), and it
cannot be turned back on without resetting Windows, so that is the owner's
decision to make. Signing does not help day to day: it only trusts
certificates from a real authority, which suits release builds.

**Run one build at a time.** `npm run dev` rebuilds the moment a file under
`src-tauri/` changes. A `cargo check` or `cargo test` started alongside it uses
different feature flags, and the two fight over `target/` badly enough to leave
it unusable. Stop the dev server first.

**`npm run dev` is the app.** It stays running for as long as the window does,
and ends when Dominus is quit from the tray. Stopping it closes the app — and
can leave `dominus.exe` behind, which the single-instance guard then hands every
new launch back to. Check for a leftover process before relaunching.

---

## Still loose

**Autostart is half-built.** The plugin is registered and never enabled, and
there is no toggle, so the app does not start with the machine. It wants a
control on The Seal rather than being switched on silently. It matters more now
than it did: program blocks are only enforced while this app is running.

**Program blocks are Windows-only.** `watcher.rs` compiles everywhere and does
nothing off Windows; a second platform needs `foreground()`, `minimize()` and
`running_applications()`, and nothing else.

**Allowance reminders can be hidden by a fullscreen game.** The reminder is a
topmost window shown without focus; an exclusive-fullscreen game may draw over
it. The gate still arrives on time. See *The warning* in `APP-LIMITS.md`.

**How hard Dominus pushes back is not a setting yet.** Running out of an
allowance raises the usual gate, which can be unlocked. A settings tab for
stricter modes, and for what counts against the streak, is a future idea.

