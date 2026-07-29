// For blocking the current site when the user clicks the "BLOCK SITE" button
let currentDomain = null;

// Seconds the confirm button stays locked before a block can be permanently
// removed from the popup. Kept as a constant so a future "normal/hard" strictness
// setting can simply dial this up.
const REMOVE_COOLDOWN_SECONDS = 10;

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

document.getElementById("trackBtn").addEventListener("click", async () => {
    chrome.tabs.create({
        url: chrome.runtime.getURL("TrackProgress.html")
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
            removeBtn.addEventListener("click", () => openRemoveModal(domain));

            item.appendChild(label);
            item.appendChild(removeBtn);
            list.appendChild(item);
        });
    });
}

// --- Removal friction gate ------------------------------------------------
// Instead of the "x" instantly deleting a block (which quietly undoes the whole
// blocked-page gauntlet), route it through a confirmation that (a) shows the
// discipline streak at stake and (b) enforces a short cooldown before the
// confirm button works — beating the impulsive in-the-moment decision.

const removeModal = document.getElementById("removeModal");
const removeModalStreak = document.getElementById("removeModalStreak");
const removeModalText = document.getElementById("removeModalText");
const removeModalCancel = document.getElementById("removeModalCancel");
const removeModalConfirm = document.getElementById("removeModalConfirm");

let pendingRemoveDomain = null;
let removeCountdownInterval = null;

function openRemoveModal(domain) {
    pendingRemoveDomain = domain;

    removeModalText.textContent =
        `Permanently remove ${domain} from your blocked list? This undoes the block completely.`;

    // Show the streak at stake. getStats() is async; guard against the modal
    // being closed or retargeted before it resolves.
    removeModalStreak.textContent = "";
    getStats().then((stats) => {
        if (pendingRemoveDomain !== domain) return;
        if (stats.currentStreak > 0) {
            const days = stats.currentStreak;
            removeModalStreak.textContent =
                `You're on a ${days}-day discipline streak — don't dismantle what you've built.`;
        }
    });

    removeModal.hidden = false;
    startRemoveCooldown();
}

// Locks the confirm button, then counts down before enabling it.
function startRemoveCooldown() {
    clearInterval(removeCountdownInterval);
    let remaining = REMOVE_COOLDOWN_SECONDS;

    removeModalConfirm.disabled = true;
    removeModalConfirm.classList.add("disabled");
    removeModalConfirm.textContent = `CONFIRM (${remaining})`;

    removeCountdownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(removeCountdownInterval);
            removeModalConfirm.disabled = false;
            removeModalConfirm.classList.remove("disabled");
            removeModalConfirm.textContent = "REMOVE BLOCK";
        } else {
            removeModalConfirm.textContent = `CONFIRM (${remaining})`;
        }
    }, 1000);
}

function closeRemoveModal() {
    clearInterval(removeCountdownInterval);
    removeModal.hidden = true;
    pendingRemoveDomain = null;
}

removeModalCancel.addEventListener("click", closeRemoveModal);

removeModalConfirm.addEventListener("click", () => {
    if (removeModalConfirm.disabled || !pendingRemoveDomain) return;
    const domain = pendingRemoveDomain;
    closeRemoveModal();
    removeBlockedSite(domain);
});

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