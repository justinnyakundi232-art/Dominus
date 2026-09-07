// Background.js — the service worker.
//
// One job: enforce the block on navigation. It is the only thing in Dominus
// that cannot be done anywhere else — the desktop app can own the rules, but
// only the browser can see a navigation and stop it.
//
// It deliberately imports nothing. The sync layer's periodic reconcile lives
// here in a later release, along with the `alarms` permission it needs; until
// there is a desktop app to reconcile with, an alarm would wake this worker
// every minute to call a function that returns immediately, and the shared
// layer would be parsed on every wake for nothing. A permission that does
// nothing is not one worth asking a user for.

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
