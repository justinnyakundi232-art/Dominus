# iOS v1 — the plan

Set 1 October 2026, after four test builds proved what the platform allows.
Open to revision, like every plan here. What the test builds found is written
up in the architecture document and in `README.md`; this is what gets built on
it.

## What v1 is

A standalone Dominus for the phone: its own fortress, syncing with nothing.
Apps are picked in Apple's picker and get the Dominus block screen; sites are
names, in the extension's categories, and are unlocked from inside the app.

The rule from the test builds holds throughout: **the phone runs the
extension's own code wherever it can.** `Categories.js` and `Tasks.js` already
run through JavaScriptCore. `Stats.js` joins them — its streak, history and
victory-rate functions are plain calculations, and the one thing it needs from
a browser, `chrome.storage.local`, is supplied from Swift over the App Group,
the way `crypto.getRandomValues` already is. A streak on the phone is worked
out by the same code as in Chrome.

## Decided

| | |
|---|---|
| **The Seal** | In v1: the password, the one-hour recovery, the escalating wait after wrong attempts. |
| **Tasks** | All three — Reflection Message, Random Passage, Guarded Code — chosen in the app, with the cooldown's length and escalation set by the user. |
| **Daily allowances** | After v1. Block and unlock only, first. |
| **The Order** | Left out until it exists. Four tabs, not five. |
| **Cooldown** | Starts over if you leave Dominus. |
| **Windows** | 15 minutes for an app, an hour for a site. |

## The screens

Four tabs, the same sections as the other two halves.

- **The Keep** — today's standing, both streaks, victory rate, and what is
  open right now with its timer. An unlock request or a running timer shows
  here first, and is made to stand out.
- **The Fortress** — apps (picked), sites (the extension's categories,
  editable, plus sites added by hand), the unlock task and the cooldown.
- **The Campaign** — progress, the history grid, records. Drawn natively; the
  figures come from `Stats.js`.
- **The Seal** — password and recovery. Backup later.

## Two rules for the design

- **Weakening costs something.** Removing an app or a site, or taking the
  fortress down, waits out the extension's ten-second pause; with a seal set,
  it asks for the password instead. Strengthening is always free. In the test
  builds all of this is free, which is the main thing v1 changes.
- **Whatever just changed draws the eye.** After an unlock, or on arriving
  from the block screen's notification, the timer or the request is
  highlighted and shown where the user is looking. In build 4 the timer
  appeared in a different section from the site that was unlocked, and went
  unnoticed.

And the one that is never up for revision: Dominus is a tool, not a cage.
Deleting the app, or turning off its Screen Time access in Settings, lifts
every block, and nothing in v1 tries to prevent either.

## Order of work

Each step is a TestFlight build that can be tried on the phone.

1. **The tabs and The Keep**, with real streaks from `Stats.js`. Stands and
   slips are already being recorded; this is where they start to count.
2. **The Fortress**: categories, hand-added sites, apps, the three tasks and
   the cooldown settings, and the pause on removal.
3. **The Campaign.**
4. **The Seal.**
5. **The icon on black**, and a polish pass over all four tabs.

Then App Review, which will want Family Controls described as what it is here:
a tool someone chooses for themselves, not parental control.
