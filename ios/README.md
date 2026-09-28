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

```sh
cd "$HOME/Dominus" && git pull
cd ios && "$HOME/xcodegen/bin/xcodegen"
open Dominus.xcodeproj
```

Then in Xcode:

1. Pick **Any iOS Device (arm64)** as the destination, next to the scheme.
2. **Product → Archive.**
3. In the Organizer that opens: **Distribute App → TestFlight Internal Only.**
   Let it manage the build number — each upload needs a higher one.
4. After processing (10–20 minutes), App Store Connect → the app →
   **TestFlight → Internal Testing**: add yourself to a group once. New builds
   then appear in the TestFlight app on the phone.

## Requirements

- iOS 16 or later on the phone (`.individual` Screen Time authorization).
- The **Family Controls** capability on every App ID — the app's and, later,
  each extension's. Distribution was granted to the account on 25 September
  2026.
- The Team ID in `project.yml` (`DEVELOPMENT_TEAM`, `NBHM4MC3CR`).
- The app record in App Store Connect, created 28 September 2026 with SKU
  `dominus-ios`. The SKU and bundle ID are permanent; the name is not.
