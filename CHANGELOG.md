# Changelog

All notable changes to **Dominus** are documented here.
This project loosely follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.7.1] — 2026-08-03

### Fixed
- **Progress emblems sit back inside the page border.** 1.7 moved the laurel wreath and cracked shield out into the page margins; they are now seated where they were before, flanking the victory meter, while still staying level with whatever stat you have scrolled to.
- Emblems are hidden on short windows, where the heading would otherwise scroll straight through them.

## [1.7] — 2026-08-01

### Added
- **Task picker** — *Add task* on Build Your Fortress now opens a dropdown of unlock tasks, each with a `(?)` tooltip explaining what it will ask of you.
- **Random Passage task** — the blocked page generates a fresh line of random words that you must retype exactly. Nothing to memorise between attempts.
- **Guarded Code task** — a code is generated once during setup for you to write down and leave somewhere inconvenient. It is never shown again, so unlocking means physically going to fetch it.
- **Configurable cooldown** — the countdown before *Unlock Site* becomes clickable is now adjustable, with a floor of one minute.
- **Escalating cooldown** — optionally multiply a site's cooldown for each repeat unlock on the same day (minimum rate 1.25×). The count resets at midnight and the result is capped at one hour, so escalation can never become a permanent lockout.
- **Streak cost in the unlock confirmation** — the modal now states the streak you are about to break, and what your next unlock of that site would cost.
- **Resistance streak** on Track Your Progress — how many times in a row you chose *Stay Focused* without unlocking, with a current and longest figure and a `(?)` tooltip. It counts choices rather than days, so it complements the discipline streak instead of repeating it; a single unlock returns it to zero, and the record survives.

### Changed
- **The laurel wreath and cracked shield are now pinned to the sides of the screen** instead of sitting beside the victory meter. They stay level with whatever stat you've scrolled to, so new stats can be added below without needing new artwork for each one. On screens too narrow to fit them beside the page they are hidden rather than allowed to overlap the text.
- The two streaks are now under their own headings, since one counts days and the other counts choices.
- **Removing a task now goes through a friction gate** — the same confirmation the popup uses for unblocking a site: it names what you're giving up, shows the streak at stake, and holds the confirm button shut for ten seconds. Removing a *Guarded Code* warns that the saved code is discarded for good. Previously one click here quietly undid whatever gauntlet the blocked page was meant to put up.
- **The cooldown pauses when you leave the tab** and resumes when you return, so it only runs while you are actually looking at it. It pauses rather than resets, so an accidental alt-tab or a notification stealing focus doesn't wipe your progress.
- **Pasting is disabled** on every typing task — the target text is on screen, so without this the tasks were one Ctrl+V away from meaningless.
- The cooldown is now configured separately from the task, since it applies to every task and to the no-task case alike.

### Notes
- Tasks saved before this release keep working: the original type-back-your-message task is now listed as **Reflection Message**.
- Everything is still stored locally in `chrome.storage.local`; no new permissions were added and no data leaves your device.

## [1.4.5] — 2026-07-29

### Added
- **Removal friction gate** — removing a site from the popup's *Currently Blocked* list now opens a confirmation that shows your discipline streak at stake and locks the confirm button behind a short cooldown, so a block can't be undone on impulse.

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

[1.7.1]: https://github.com/justinnyakundi232-art/Dominus/releases
[1.7]: https://github.com/justinnyakundi232-art/Dominus/releases
[1.4.5]: https://github.com/justinnyakundi232-art/Dominus/releases
[1.4]: https://github.com/justinnyakundi232-art/Dominus/releases
[1.2]: https://github.com/justinnyakundi232-art/Dominus/releases
[1.0]: https://github.com/justinnyakundi232-art/Dominus/releases
