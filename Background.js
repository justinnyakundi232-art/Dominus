// Background.js — the service worker.
//
// Two jobs: enforce the block on navigation, and keep the sync layer ticking.
// The first is the only thing in Dominus that cannot be done anywhere else —
// the desktop app can own the rules, but only the browser can see a navigation
// and stop it.
//
// 1.11 shipped with neither the tick nor the `alarms` permission, because there
// was nothing to reconcile with: the alarm would have woken this worker sixty
// times an hour to call a function that returned immediately, and a permission
// that does nothing is not one worth asking a user for. Both come back here, in
// the release that has a peer to reconcile with.

// The shared layer, in the same load-in-any-order shape the pages use. None of
// these touch storage or the DOM at load time, which is what makes them safe to
// pull into a worker that has no DOM at all.
importScripts("Tasks.js", "Categories.js", "Stats.js", "Seal.js", "Sync.js",
              "LocalPeer.js");

// ---- Enforcement ----------------------------------------------------------

//for blocking the site when the user tries to navigate to it
chrome.webNavigation.onBeforeNavigate.addListener((details) => {

    // ignore navigation inside iframes etc, only act on the top-level frame
    if (details.frameId !== 0) return;

    chrome.storage.local.get(["blockedSites", "tempUnlocks"], (result) => {
        let blocked = result.blockedSites || [];
        let tempUnlocks = result.tempUnlocks || {};

        let currentUrl = new URL(details.url);
        let domain =
            currentUrl.hostname.replace(/^www\./, "");

        if (!blocked.includes(domain)) return;

        // check for an active temporary unlock on this domain
        let expiry = tempUnlocks[domain];
        if (expiry && Date.now() < expiry) {
            return; // still within the unlocked window, let it through
        }

        // expired unlock, clean it up so it doesn't linger in storage
        if (expiry && Date.now() >= expiry) {
            delete tempUnlocks[domain];
            chrome.storage.local.set({ tempUnlocks: tempUnlocks });
        }

        let blockedPageUrl = chrome.runtime.getURL("Blocked.html") +
            "?url=" + encodeURIComponent(details.url);

        chrome.tabs.update(details.tabId, {
            url: blockedPageUrl
        });
    });

});

// ---- Sync tick ------------------------------------------------------------
//
// A periodic reconcile rather than a live connection, because there cannot be a
// live one: the service worker is terminated after about thirty seconds idle,
// so anything holding a socket open from this side is designing against the
// platform. An alarm survives that termination and wakes the worker back up,
// which is exactly the shape the sync layer wants — two peers that are usually
// out of contact and occasionally reconcile.
//
// One minute is the floor Chrome enforces on alarm periods. It sets the worst
// case for how stale a peer's view can get; the common case will be much
// shorter once there is a transport, because a commit pushes immediately rather
// than waiting for the tick.
//
// syncNow() resolves { status: "no-peer" } until this browser has been paired
// with the desktop app. LocalPeer.js installs the transport that changes that,
// and every failure inside it resolves to "no-peer" rather than throwing — an
// app that is closed, crashed or answering with nonsense must cost this worker
// nothing, because the enforcement above never waits on any of it.

const SYNC_ALARM = "dominus-sync";
const SYNC_PERIOD_MINUTES = 1;

function ensureSyncAlarm() {
    chrome.alarms.get(SYNC_ALARM, (existing) => {
        if (existing) return;
        chrome.alarms.create(SYNC_ALARM, {
            periodInMinutes: SYNC_PERIOD_MINUTES
        });
    });
}

chrome.runtime.onInstalled.addListener(ensureSyncAlarm);
chrome.runtime.onStartup.addListener(ensureSyncAlarm);

// Also on plain worker wake-up: onInstalled and onStartup between them miss the
// case where the worker was terminated and revived by something else, and an
// alarm that was never created is an alarm that never fires.
ensureSyncAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SYNC_ALARM) return;
    syncNow();
});
