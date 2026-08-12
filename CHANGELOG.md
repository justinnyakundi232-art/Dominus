# Changelog

All notable changes to **Dominus** are documented here.
This project loosely follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.8] — 2026-08-12

### Added
- **Custom categories.** The category list is now yours: rename any of them, edit which sites they hold, add categories of your own, and delete ones you don't want. The three that ship with Dominus are only a starting point — nothing about them is fixed any more.
- **Per-category tasks and cooldowns.** A category can be given its own standards instead of the fortress-wide ones, so gaming can demand a Guarded Code while the news gets sixty seconds. Task and cooldown are overridden independently, and either one left alone still inherits the fortress default.
- **The blocked page names the category responsible**, and says when that category sets its own terms — so a longer cooldown or an unexpected task is never a mystery.
- **The popup groups your blocked sites by category.** *Currently Blocked* is now listed under headings — one per category, in the order they sit in your fortress, with anything you blocked by hand gathered under *Added manually* at the end. The headings stay put as the list scrolls, and a permanent category is marked as one. A site that belongs to more than one category is listed once, under the category that governs it, with a line naming the others.
- **A banner for each category** — a colour and a mark, chosen from a fixed heraldic set rather than a free colour picker, so nothing can be made to clash with the rest of the page. The banner appears beside the category on the fortress page, on its heading in the popup, and next to the category named on the blocked page.

### Changed
- **Removing a site from the popup now takes it out of its categories too**, and the confirmation says so before you commit. Previously the site would quietly reappear the next time you saved your fortress, which read as the removal having failed.
- **Deleting a category that is switched on goes through a friction gate** — the same confirmation used for removing a block or a task. It names how many sites stop being blocked and shows the streak at stake. A category that isn't switched on isn't defending anything, so it just goes.
- **Turning off a category's own standards is gated as well** when it has a task saved, since that single click otherwise undoes a task you deliberately set. Editing the task inside the picker stays ungated, exactly as it already worked for the fortress-wide task.
- Sites typed into a category are cleaned up as they're saved — a pasted `https://www.youtube.com/feed` becomes `youtube.com`, so a block can't silently fail to match because of how it was written.

### Fixed
- **Ticking and unticking a category no longer deletes sites you blocked by hand.** If you blocked `youtube.com` from the popup and then switched Video Streaming on and off, the category removed its whole preset list on the way out — including the site it never added. Blocks made from the popup are now tracked separately, and the blocked list is derived from the two, so a category can only ever take away what it brought.

### Notes
- A site can sit in more than one category. Permanence resolves most-restrictive — if any category holding a site is permanently blocked, the site is — while its task and cooldown come from the highest such category in your list, which the blocked page names.
- Fortresses built before this release carry over untouched: the three categories keep their settings, and anything you had blocked by hand is preserved as a manual block.
- Everything is still stored locally in `chrome.storage.local`; no new permissions were added and no data leaves your device.

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
