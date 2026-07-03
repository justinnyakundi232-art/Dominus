// Read the original blocked URL from the query string
function getOriginalUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get("url");
}

const COOLDOWN_SECONDS = 60;
const TEMP_UNLOCK_DURATION_MS = 60 * 60 * 1000; // 1 hour

const mainHeading = document.getElementById("mainHeading");
const subtitle = document.getElementById("subtitle");
const taskArea = document.getElementById("taskArea");
const unlockBtn = document.getElementById("unlockBtn");
const categories = {
    socialMedia: [
        "facebook.com",
        "instagram.com",
        "reddit.com",
        "x.com",
        "tiktok.com",
        "snapchat.com"
    ],

    videoStreaming: [
        "youtube.com",
        "netflix.com",
        "twitch.tv",
        "hulu.com",
        "disneyplus.com"
    ],

    gaming: [
        "roblox.com",
        "steamcommunity.com",
        "epicgames.com",
        "miniclip.com"
    ]
};

// Finds which category (if any) a domain belongs to
function getCategoryForDomain(domain) {
    for (const categoryName in categories) {
        if (categories[categoryName].includes(domain)) {
            return categoryName;
        }
    }
    return null;
}
let countdownInterval = null;
let originalUrl = getOriginalUrl();

// "RETURN" / "STAY FOCUSED" button — always available, closes the tab
document.getElementById("focusBtn").addEventListener("click", async () => {
    let [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    chrome.tabs.remove(tab.id);
});

// Renders the initial "Complete Task to Unblock" button
// Renders the initial "Complete Task to Unblock" button, or a disabled
// permanent-block message if the site's category is set to permanent
function renderCompleteTaskButton() {
    chrome.storage.local.get(["categorySettings"], (result) => {
        const settings = result.categorySettings || {};
        const domain = originalUrl
            ? new URL(originalUrl).hostname.replace(/^www\./, "")
            : null;
        const category = domain ? getCategoryForDomain(domain) : null;
        const isPermanent = category && settings[category]?.permanent;

        if (isPermanent) {
            taskArea.innerHTML = `
                <button id="completeTaskBtn" disabled class="permanent-disabled">COMPLETE TASK TO UNBLOCK</button>
                <p class="permanent-note">You set this to permanently blocked for a reason.</p>
            `;
            return;
        }

        taskArea.innerHTML = `<button id="completeTaskBtn">COMPLETE TASK TO UNBLOCK</button>`;

        document.getElementById("completeTaskBtn")
            .addEventListener("click", () => {
                chrome.storage.local.get(["unlockTask"], (taskResult) => {
                    if (taskResult.unlockTask && taskResult.unlockTask.message) {
                        renderTaskConfirmBox(taskResult.unlockTask.message);
                    } else {
                        startCountdown();
                    }
                });
            });
    });
}

// Renders the "type the message back" confirmation form
function renderTaskConfirmBox(targetMessage) {
    taskArea.innerHTML = `
        <div class="task-confirm-box">
            <p class="task-instruction">Type the message below exactly to begin your cooldown:</p>
            <p class="task-target-message">"${targetMessage}"</p>
            <textarea id="confirmInput" placeholder="Type it here..."></textarea>
            <p class="task-error" id="taskError"></p>
            <button id="confirmTaskBtn">CONFIRM</button>
        </div>
    `;

    document.getElementById("confirmTaskBtn")
        .addEventListener("click", () => {
            const input = document.getElementById("confirmInput").value;
            const errorEl = document.getElementById("taskError");

            if (input === targetMessage) {
                startCountdown(targetMessage);
            } else {
                errorEl.textContent = "That doesn't match. Try again.";
            }
        });
}

// Starts the cooldown countdown, updates heading/subtitle, and manages the unlock button
function startCountdown(taskMessage) {
    taskArea.innerHTML = "";

    if (taskMessage) {
        mainHeading.textContent = taskMessage;
    }

    let remaining = COOLDOWN_SECONDS;

    function updateDisplay() {
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        subtitle.textContent =
            `${minutes}:${seconds.toString().padStart(2, "0")}`;
    }

    updateDisplay();

    countdownInterval = setInterval(() => {
        remaining--;

        if (remaining <= 0) {
            clearInterval(countdownInterval);
            remaining = 0;
            updateDisplay();
            activateUnlockButton();
        } else {
            updateDisplay();
        }
    }, 1000);
}

// Switches the unlock button from disabled/faded to active/glowing
function activateUnlockButton() {
    unlockBtn.disabled = false;
    unlockBtn.classList.remove("disabled");
    unlockBtn.classList.add("ready");
}

// Handles the actual unlock: temporary window, then redirect to the original site
unlockBtn.addEventListener("click", () => {
    if (unlockBtn.disabled) return;
    if (!originalUrl) return;

    const domain = new URL(originalUrl).hostname.replace(/^www\./, "");

    const confirmed = confirm(
        `You are about to unlock ${domain} for 1 hour.\n\nAfter that, it will be blocked again automatically.\n\nAre you sure?`
    );
    if (!confirmed) return;

    const expiry = Date.now() + TEMP_UNLOCK_DURATION_MS;

    chrome.storage.local.get(["tempUnlocks"], (result) => {
        let tempUnlocks = result.tempUnlocks || {};
        tempUnlocks[domain] = expiry;

        chrome.storage.local.set({ tempUnlocks: tempUnlocks }, async () => {
            let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            chrome.tabs.update(tab.id, { url: originalUrl });
        });
    });
});

// Initial render on page load
renderCompleteTaskButton();