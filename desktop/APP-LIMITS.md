# Limits on applications

Phase 3, and the actual reason to install the desktop app. The browser cannot
see Steam. This can.

Status: **built, Windows only.** Written before either side had code, for the
same reason `SYNC-PROTOCOL.md` was, and amended where building it proved the
design wrong. The amendments are marked *Changed in building*, because the
reason a decision was reversed is worth more than the decision.

---

## What an application limit is, in this release

Exactly what a site block is. An application is in your fortress or it is not.
Opening a blocked one raises the same gate a blocked page raises: the unlock
task you chose, the cooldown you chose, escalating the same way, and a slip
counts against the same streak.

That is a deliberate limit on scope. The obvious richer design is a **daily
budget** — Steam gets thirty minutes — and it is the right eventual answer,
because an application is not the same kind of temptation as a website: if you
truly did not want the application you would uninstall it, so the fact that it
is still on the machine means it has a use. A website cannot be uninstalled, so
blocking it outright costs nothing you wanted.

But a budget is a second mechanic, not the existing one extended. It needs its
own merge rules (two devices spending from one budget is a genuinely hard
problem — see *What a budget would need* at the bottom), its own per-day
accounting, and a second answer to the question "what is a slip". It arrives
with a settings page where you choose what counts against you, because once an
app has a budget that question stops having one obvious answer.

So: same mechanic now, budget later, and nothing here forecloses it.

---

## What happens when you open a blocked application

Dominus **minimizes the window and raises the gate over it**. The process keeps
running.

Not terminated. Killing a process can lose unsaved work, and it designs against
the user rather than for them — which is the one thing Dominus has never done.
The whole product is friction that makes a decision deliberate, never a wall
that makes it impossible. An unlock simply lets you switch back to a program
that was there the whole time.

Not an always-on-top window over an untouched app either. That is dismissed by
clicking the app behind it, which makes the gate decorative — and a gate that
costs nothing teaches you that gates cost nothing.

Minimizing is the smallest action that actually interrupts. It is reversible by
the user at any moment (they can restore the window from the taskbar, and
Dominus will simply minimize it again), it destroys nothing, and it is honest
about what it is: an interruption, not a prohibition.

---

## The data

One new field on the fortress:

```js
fortress = {
    categories,     // sites, unchanged
    manualSites,    // unchanged
    applications,   // NEW
    task,           // shared: the same unlock task governs both
    cooldown        // shared: the same cooldown governs both
}
```

An application:

```js
{ id: "app:steam.exe", name: "Steam", exe: "steam.exe",
  enabled: true, permanent: false }
```

**`exe` is the identity, and the id is derived from it.** `id` is
`"app:" + exe`, where `exe` is the executable's basename, lowercased. This is
not laziness about ids — it is what lets two devices that each blocked Steam,
independently, agree that they blocked the same thing. A random id would make
those two entries different applications forever, and the union would hand the
user two Steams.

`name` is cosmetic and follows the newer commit, exactly as a category's name
and colour do.

**Not the full path.** `C:\Program Files (x86)\Steam\steam.exe` differs between
machines, between drives, and after a reinstall, and Phase 5 puts this fortress
on a second computer. The basename is what is stable. The cost is that any
program named `steam.exe` matches, which is a cost worth paying and worth
saying out loud on the picker.

### Why applications are not a category

A category is a named group with its own optional standards, and its order
matters because the first enabled category containing a domain governs it.
Applications have none of that in this release: there is no grouping, no
per-application task, and no ordering question because a process matches exactly
one entry. Modelling them as categories would ship four fields that do nothing
and a merge rule for each.

They are closer to `manualSites` — a flat list of things you blocked by hand —
with `enabled` and `permanent` on each, because switching one off has to be a
weakening the seal can see.

### Choosing a program

The desktop app offers a list of what is open right now: top-level windows that
are visible, titled, unowned and not tool windows — the ones in the taskbar —
grouped by executable. That filter is what turns a process table of two hundred
entries into a list of things a person recognises. Each row shows a window title
beside the executable to help with that; the title is never stored.

*Changed in building:* the list was fetched once, when the picker opened, and
went stale in the most ordinary use of it — close one program, open the one you
mean to block, and the picker still showed the first and not the second. It now
asks again every two seconds while it is visible, and again when the window
regains focus, and only redraws when the answer changed.

### Programs that can never be blocked

A floor, not a preference. `PROTECTED_EXECUTABLES` in `Applications.js`:

| | why |
|---|---|
| `explorer.exe` | the Windows shell. It owns the taskbar and the desktop, so clicking either makes it the foreground — and the gate would minimize the thing you use to get anywhere |
| `taskmgr.exe` | the way out of anything. A fortress that can block the exit is a cage |
| `dominus.exe` | the gate is a Dominus window |
| `systemsettings.exe` | where a program you truly do not want is uninstalled — the honest fix, which Dominus must never stand in front of |
| `applicationframehost.exe` | hosts every Store app, so blocking it would block all of them under one name |
| the rest | parts of Windows that briefly take the foreground: Start, search, the lock screen, notifications |

Enforced where an application **enters** the fortress: `normalizeApplication()`
refuses these, so a list from a peer, a backup or a hand-edited file cannot
carry one in either. The picker leaves them out rather than showing them
disabled — a greyed-out Task Manager invites a question whose only answer is
"because it would lock you out".

Rust deliberately has no copy of this list. The decision is made once.

---

## Merging

Strengthen-wins, like everything in Channel B.

```
mergeApplications(mine, theirs, myRev, theirRev)
```

Union by id. Order follows whichever side committed more recently, as
`mergeCategories()` does, though nothing depends on it. Per entry:

| field | rule | why |
|---|---|---|
| `id`, `exe` | identical by construction | the id is derived from the exe |
| `name` | newer commit | cosmetic, no stronger direction |
| `enabled` | `mine \|\| theirs` | blocked beats not blocked |
| `permanent` | `mine \|\| theirs` | unremovable beats removable |

Idempotent, like every rule in `mergePeerState()`: the tick runs forever, and
merging a settled state with itself has to change nothing. A union of sets and
two boolean ORs cannot fail that.

### Weakening

Two new fields on an authored record:

```js
applicationsRemoved:  ["app:steam.exe"]
applicationsDisabled: ["app:steam.exe"]
```

They travel and apply by the same four rules as everything else — appended to a
list, kept on merge, landing only where every peer *holding* the record is also
without the thing, and yielding to a decision made after them. Nothing about
applications needed a fifth rule, which is the point of having got those four
right in 1.12.

---

## Enforcement, and where it runs

**In Rust, not in the window.** The webview is throttled when hidden, and
Dominus is meant to spend most of its life hidden in the tray. Enforcement that
stops working when nobody is looking at it is not enforcement.

So the Rust side holds a small **enforcement view**, pushed to it by the window
whenever the state changes:

```rust
struct Enforced {
    blocked: Vec<String>,          // lowercased exe basenames, enabled only
    unlocked_until: HashMap<String, u64>,   // exe -> epoch ms
}
```

That is all it holds. It has no merge rules, no authoring rules, and no opinion
about what should be blocked — the same division as everywhere else in this
protocol.

The window sends it on load, after every edit, and on a twenty-second timer. The
timer carries a change that arrived from the extension while nobody was looking;
the extension reconciles once a minute, so anything faster only re-sends what
Rust already has, and an unchanged list is skipped. A window with no state at
all sends nothing — an empty list from a fresh window would switch every block
off. Rust keeps the last list in `enforced.json`, so a cold start enforces before
the window has spoken.

The watcher polls the foreground window once a second:

```
GetForegroundWindow
  -> GetWindowThreadProcessId
  -> OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)
  -> QueryFullProcessImageNameW
  -> basename, lowercased
```

`PROCESS_QUERY_LIMITED_INFORMATION` rather than `PROCESS_QUERY_INFORMATION`
because it is the least that answers the question, and it works against
processes at a higher integrity level without Dominus needing to be elevated.

One second is chosen against two failure modes. Faster is a poll that runs
86,400 times a day for a person who blocked nothing. Slower and you get a
visible pause between clicking Steam and being stopped, which reads as a bug
rather than as a gate.

On a match with no live unlock: `ShowWindow(hwnd, SW_MINIMIZE)`, then raise the
gate window. The same executable is not gated again until it has left the
foreground and come back, or the gate is dismissed — otherwise every tick would
re-raise a gate the user is currently reading.

### Where enforcement must never wait

The extension's rule applies here in reverse. The window being hidden, the
webview being throttled, or a sync being overdue must never make the gate
weaker — Rust already holds everything it needs to decide, and decides alone.

The opposite is also true and is the part worth stating: **the Rust side never
records anything.** It cannot write a stand, an unlock, or a fortress edit. It
raises a gate and reports what happened. All record-keeping goes through the
window and `Sync.js`, which is why there is still exactly one implementation of
every rule.

---

## The gate

A second Tauri window, `gate`, loading `src/gate.html`. Always on top,
undecorated, centred, not in the taskbar. It shows what was stopped and the
unlock task, and it looks like `Blocked.html` because it is the same gate.

Three ways out:

- **Walk away.** Closes the gate, records a **stand**, and the app stays
  minimized. Same event the browser records, same effect on both streaks.
- **Unlock.** The task, then the cooldown, then a temporary window. Records an
  **unlock** with `domain` set to the exe.
- **Nothing.** The gate stays. It is not modal to the system and it does not
  trap input — you can alt-tab away from it, and the blocked app stays
  minimized because nothing un-minimized it.

An unlock opens the program for fifteen minutes. The expiry goes into
`tempUnlocks` beside the site ones, keyed by executable, and into what Rust
enforces — so the gate returns on its own when the window closes.

*Changed in building:* the gate learns what it is guarding from a `gate-raised`
event, and the gate window was missing from the capability that permits
listening for one. Nothing failed loudly. Plain commands still worked, so the
first Walk Away closed the gate — but the gate never knew which program it was
guarding, never loaded the fortress, recorded nothing, and never reset, so every
button on the next gate did nothing at all. Both windows are in the capability
now, and the gate no longer depends on the event: it asks Rust what it is
guarding whenever it is shown or focused, and every button waits for the
fortress to finish loading before it answers.

### Why the exe goes in `domain`

Because the event log already does everything needed, and puts it in the right
place for free:

- `deriveEscalation()` counts today's unlocks **per `domain`**, so unlocking
  Steam three times escalates Steam's cooldown without touching YouTube's.
- `deriveDayLog()` and `deriveResistance()` do not read `domain` at all, so a
  slip on Steam counts exactly like a slip on YouTube — which is what "the same
  mechanic" means.
- The union merge is by event id, so an unlock recorded by the app arrives at
  the extension on the next tick and cannot double-count however often it
  merges.

**The event log needs no changes for Phase 3.** That is the strongest evidence
that Channel A was designed right in 1.11: the first genuinely new kind of
thing to record needed no new kind of record.

---

## What the extension does with applications

Stores them, merges them, seals them, exports them — and enforces none of them,
because it cannot see a process. It still has to carry them: the extension is
the merge authority and the record holder, and a fortress that lost its
applications whenever the desktop app was closed would not be one fortress.

Its *Fortress* has a **Programs** panel with *Stand down* and *Remove*. It
cannot add one — that means picking from what is running, which a browser
cannot see — but adding never needed the seal anyway. Each action saves on its
own, like *Remove Task*: an open fortress holds the confirm for ten seconds, and
a sealed one goes straight to the seal prompt, which names the program.

*Changed in building:* this was designed read-only, and that was wrong. On a
sealed fortress the desktop app refuses every weakening, because the password
prompt lives in the extension — so a program blocked from the app could not be
unblocked anywhere. A block that can only be taken down somewhere the seal
cannot be asked for is a block that cannot be taken down at all.

Building it also found that `writeFortress()` never wrote programs: a removal
would have passed the seal, stamped its record, and not been saved. It writes
them now whenever the state carries them, and leaves them alone when a save
never read them.

### Saying what the controls mean

*Stand down* is off for now, with nothing deleted; *Remove* is gone for good;
*Take up* turns it back on. Both surfaces say so on hover, in the same words.

On a sealed fortress the desktop app's weakening controls are held with
`aria-disabled` rather than `disabled`, because Chromium does not reliably show
a tooltip on a disabled button — and the moment someone meets the not-allowed
cursor is the moment the explanation matters. They say what they would do and
then that the prompt is in The Fortress in Chrome, and a click explains the same
in the status line rather than doing nothing.

---

## What a budget would need, when it arrives

Written down now while the reasoning is fresh, so 1.13 does not rediscover it.

A budget is **spent**, and spending is the one thing strengthen-wins cannot
merge. Two devices that each saw twenty minutes of a thirty-minute budget have
not seen forty minutes and have not seen twenty; the truth depends on whether it
was the same twenty. Taking the maximum under-counts, summing over-counts, and
neither is idempotent — which is the property the whole tick depends on.

The shape that works is the one Channel A already uses: **do not merge the
number, derive it.** Spend arrives as events (`app-used`, with a duration and a
device), the union is by id, and the day's spend is the sum over distinct
events. Idempotent by construction, exactly like the stand and unlock counters.

The open question is not the merge; it is what a budget *running out* does, and
whether exhausting it is a slip. That is the settings page, and it is why the
settings page is part of the same release.
