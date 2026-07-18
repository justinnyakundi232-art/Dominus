# Changelog

All notable changes to **Dominus** are documented here.
This project loosely follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.4] — 2026-07-17

### Added
- **Track Your Progress page** — a new stats page, opened from the popup, showing a victory-rate meter and progress emblems.
- **Discipline streak** — a clean-day streak (consecutive days with no unlock) shown on both the blocked page and the Track Your Progress page, plus a longest-streak record.
- **Victory rate** — the share of blocked-site moments where you chose *Stay Focused* instead of unlocking, shown as a percentage and a 10-square meter.
- **Hover/focus tooltip** on the victory-rate `(?)` explaining what the metric measures.

### Fixed
- Popup footer ("Hold your ground") no longer overlaps the **Currently Blocked** list when several sites are blocked.

### Notes
- All stats are stored locally in `chrome.storage.local`; no new permissions were added and no data leaves your device.

## [1.2]

### Added
- **Blocked-site management** in the popup, with a **Currently Blocked** list and per-site removal.
- **In-page unlock modal** with a cooldown before a temporary unlock is granted.

### Changed
- Clearer naming and copy throughout the extension.

## [1.0] — Initial release

### Added
- Chrome Web Store MVP: block distracting sites, the **Build Your Fortress** setup page, and the main popup.

[1.4]: https://github.com/justinnyakundi232-art/Dominus/releases
[1.2]: https://github.com/justinnyakundi232-art/Dominus/releases
[1.0]: https://github.com/justinnyakundi232-art/Dominus/releases
