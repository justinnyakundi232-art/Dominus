// For blocking the current site when the user clicks the "BLOCK SITE" button
let currentDomain = null;

document.addEventListener("DOMContentLoaded", async () => {
    renderBlockedList();

    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Guard against chrome:// or other non-blockable pages
    if (!tab.url || !tab.url.startsWith("http")) {
        document.getElementById("blockBtn").textContent = "CANNOT BLOCK THIS PAGE";
        document.getElementById("blockBtn").disabled = true;
        return;
    }

    currentDomain = new URL(tab.url).hostname.replace(/^www\./, "");

    chrome.storage.local.get(["blockedSites"], (result) => {
        updateBlockButton(result.blockedSites || []);
    });
});

// Updates the main block button's label/state for the active tab's domain
function updateBlockButton(blocked) {
    if (!currentDomain) return;
    const blockBtn = document.getElementById("blockBtn");

    if (blocked.includes(currentDomain)) {
        blockBtn.textContent = `${currentDomain.toUpperCase()} IS BLOCKED`;
        blockBtn.disabled = true;
    } else {
        blockBtn.textContent = `BLOCK ${currentDomain.toUpperCase()}`;
        blockBtn.disabled = false;
    }
}

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
                url: chrome.runtime.getURL("Blocked.html") +
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

// Renders the "Currently Blocked" list with per-site remove buttons
function renderBlockedList() {
    chrome.storage.local.get(["blockedSites"], (result) => {
        const blocked = result.blockedSites || [];
        const section = document.getElementById("blockedListSection");
        const list = document.getElementById("blockedList");

        list.innerHTML = "";

        if (blocked.length === 0) {
            section.hidden = true;
            return;
        }

        section.hidden = false;

        blocked.slice().sort().forEach((domain) => {
            const item = document.createElement("li");
            item.className = "blocked-item";

            const label = document.createElement("span");
            label.textContent = domain;

            const removeBtn = document.createElement("button");
            removeBtn.className = "remove-blocked-btn";
            removeBtn.textContent = "×";
            removeBtn.setAttribute("aria-label", `Unblock ${domain}`);
            removeBtn.addEventListener("click", () => removeBlockedSite(domain));

            item.appendChild(label);
            item.appendChild(removeBtn);
            list.appendChild(item);
        });
    });
}

// Removes a single domain from the blocked list and refreshes the popup UI
function removeBlockedSite(domain) {
    chrome.storage.local.get(["blockedSites"], (result) => {
        let blocked = (result.blockedSites || []).filter((d) => d !== domain);

        chrome.storage.local.set({ blockedSites: blocked }, () => {
            renderBlockedList();
            updateBlockButton(blocked);
        });
    });
}