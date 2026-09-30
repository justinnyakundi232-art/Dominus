# Dominus for iOS

The third peer. On the desktop, sites and programs are split between the
extension and the app because neither can do the other's job; on iOS one app
does both, through Screen Time (FamilyControls, ManagedSettings,
DeviceActivity).

The first release is **standalone** — its own fortress, no sync. When sync
comes, the merge runs on the phone through JavaScriptCore using the same
`Sync.js` as the other two halves, and the server only relays. There is never
a Swift copy of the merge rules.

## How it is built

The project is written on Windows and built on a rented Mac, which cannot see
a phone plugged into the PC. So builds reach the iPhone through **TestFlight**,
internal testing only, which needs no review.

`project.yml` describes the project; XcodeGen generates `Dominus.xcodeproj`
from it. The generated project is gitignored — edit `project.yml`, never the
project.

The extension's shared scripts are bundled from the repository root as they
are (`Categories.js` and `Tasks.js` so far) and run through JavaScriptCore by
`SharedRules.swift`, so the whole repository has to be checked out on the
Mac, not just `ios/`. The one browser API they need, `crypto.getRandomValues`,
is supplied from Swift.

### Once, on the Mac

XcodeGen without Homebrew (the rented plan has no admin rights):

```sh
cd "$HOME"
curl -L -o xcodegen.zip https://github.com/yonaskolb/XcodeGen/releases/latest/download/xcodegen.zip
unzip -o xcodegen.zip
git clone https://github.com/justinnyakundi232-art/Dominus.git
```

In Xcode → Settings → Accounts, add the Apple ID that owns the developer
account. On the iPhone, install TestFlight.

### Every build

**Quit Xcode first** (⌘Q, not just the window). An open Xcode keeps building
the project it already loaded, and new files then fail as "Cannot find … in
scope".

```sh
cd "$HOME/Dominus" && git pull
cd ios && "$HOME/xcodegen/bin/xcodegen"
open Dominus.xcodeproj
```

XcodeGen should end with `Created project at …`; anything else is an error
worth reading before opening Xcode.

Then in Xcode:

1. Pick **Any iOS Device (arm64)** as the destination, next to the scheme.
2. **Product → Archive.**
3. In the Organizer that opens: **Distribute App → TestFlight Internal Only.**
   Archive the **Dominus** scheme, not an extension's — it builds both
   extensions and embeds them.
   Each upload needs a build number App Store Connect has never seen for the
   app, under any version, even after a refused upload. It is
   `CURRENT_PROJECT_VERSION` in `project.yml`, raised with every push meant
   for TestFlight and never reset. A "Redundant Binary Upload" error means it
   wasn't.
4. After processing (10–20 minutes), App Store Connect → the app →
   **TestFlight → Internal Testing**: add yourself to a group once. New builds
   then appear in the TestFlight app on the phone.

## The targets

| Target | Bundle ID | What it is |
|---|---|---|
| `Dominus` | `com.aj7developments.dominus` | The app |
| `DominusShield` | `….dominus.shield` | Draws the block screen |
| `DominusShieldAction` | `….dominus.shieldaction` | Handles its two buttons |
| `DominusMonitor` | `….dominus.monitor` | Puts a block back when an unlock runs out |

The fortress lives in the App Group `group.com.aj7developments.dominus`
(`Shared/FortressState.swift`), because the app isn't the only thing that acts
on it.

The block screen can't open the app. Its Unlock button leaves a request in the
App Group and posts a notification; the app reads the request when it comes to
the front. See `Shared/Gate.swift`.

A site typed by name never reaches the block screen: it is stopped by the web
content filter, which draws its own page with no buttons. Those are unlocked
from their entry in the app.

An unlock runs as the extension's blocked page does — Random Passage, then the
cooldown from `Tasks.js` (starting over if you leave Dominus), then a last
confirmation — and opens one thing for 15 minutes (an app) or an hour (a site).
It starts a DeviceActivity timer of the same length, and `DominusMonitor`
re-applies the fortress when it ends. DeviceActivity refuses intervals under
15 minutes, so the timer's end is rounded up to the next whole minute.

## Requirements

- iOS 16 or later on the phone (`.individual` Screen Time authorization).
- The **Family Controls** capability on every App ID — the app's and each
  extension's. Distribution was granted to the account on 25 September 2026.
- The App Group on the app's, the shield action's and the monitor's App IDs.
- The Team ID in `project.yml` (`DEVELOPMENT_TEAM`, `NBHM4MC3CR`).
- The app record in App Store Connect, created 28 September 2026 with SKU
  `dominus-ios`. The SKU and bundle ID are permanent; the name is not.
