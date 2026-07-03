// For blocking the current site when the user clicks the "BLOCK SITE" button
document.addEventListener("DOMContentLoaded", async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Guard against chrome:// or other non-blockable pages
    if (!tab.url || !tab.url.startsWith("http")) {
        document.getElementById("blockBtn").textContent = "CANNOT BLOCK THIS PAGE";
        document.getElementById("blockBtn").disabled = true;
        return;
    }

    let domain = new URL(tab.url).hostname.replace(/^www\./, "");

    chrome.storage.local.get(["blockedSites"], (result) => {
        let blocked = result.blockedSites || [];
        if (blocked.includes(domain)) {
            document.getElementById("blockBtn").textContent = `${domain.toUpperCase()} IS BLOCKED`;
            document.getElementById("blockBtn").disabled = true;
        } else {
            document.getElementById("blockBtn").textContent = `BLOCK ${domain.toUpperCase()}`;
        }
    });
});

document.getElementById("blockBtn").addEventListener("click", async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || !tab.url.startsWith("http")) return;

    let domain = new URL(tab.url).hostname.replace(/^www\./, "");

    chrome.storage.local.get(["blockedSites"], (result) => {
        let blocked = result.blockedSites || [];
        if (blocked.includes(domain)) return;

        blocked.push(domain);
        chrome.storage.local.set({ blockedSites: blocked }, () => {
            chrome.tabs.update(tab.id, {
                url: chrome.runtime.getURL("blocked.html") +
                    "?url=" + encodeURIComponent(tab.url)
            });
        });
    });
});

// For creating a new tab with the "Build Fortress" page when the user clicks the "BUILD THE FORTRESS" button
document.getElementById("buildBtn").addEventListener("click", async () => {
    chrome.tabs.create({
        url: chrome.runtime.getURL("BuildFortress.html")
    });
});