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