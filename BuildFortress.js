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

document.querySelector(".save-btn")
.addEventListener("click", () => {
    
    
    chrome.storage.local.get(["blockedSites", "unlockTask"], (result) => {
        const messageInput = document.getElementById("taskMessage");
        const taskToSave = messageInput
        ? { type: "cooldown", message: messageInput.value.trim() || "Take a breath. You set this block." }
        : (result.unlockTask || null);  // keep existing task if form isn't open

        let blockedSites = new Set(
            result.blockedSites || []
        );

        let categorySettings = {};

        if (document.getElementById("socialMedia").checked) {

            categorySettings.socialMedia = {
                enabled: true,
                permanent:
                    document.getElementById(
                    "socialMediaPermanent"
                ).checked
            };
            categories.socialMedia.forEach(site => {
                blockedSites.add(site);
            });
        }else if(document.getElementById("socialMedia").checked === false ) {
            categories.socialMedia.forEach(site => {
                blockedSites.delete(site);
            });
        }

        if (document.getElementById("videoStreaming").checked) {

            categorySettings.videoStreaming = {
                enabled: true,
                permanent:
                    document.getElementById(
                    "videoStreamingPermanent"
                ).checked
            };

            categories.videoStreaming.forEach(site => {
                blockedSites.add(site);
            });
        }else if(document.getElementById("videoStreaming").checked === false) {
            categories.videoStreaming.forEach(site => {
                blockedSites.delete(site);
            });
        }

        if (document.getElementById("gaming").checked) {

            categorySettings.gaming = {
                enabled: true,
                permanent:
                    document.getElementById(
                    "gamingPermanent"
                ).checked
            };

            categories.gaming.forEach(site => {
                blockedSites.add(site);
            });
        }else if(document.getElementById("gaming").checked === false ) {
            categories.gaming.forEach(site => {
                blockedSites.delete(site);
            });
        }
        
        chrome.storage.local.set({
            blockedSites: [...blockedSites],
            categorySettings: categorySettings,
            unlockTask: taskToSave
        }, () => {
            const saveBtn = document.querySelector(".save-btn");
            const original = saveBtn.textContent;
            saveBtn.textContent = "✓ FORTRESS SAVED";
            saveBtn.disabled = true;
            setTimeout(() => {
                saveBtn.textContent = original;
                saveBtn.disabled = false;
            }, 2000);
        });

    });

});

document.addEventListener("DOMContentLoaded", () => {

    chrome.storage.local.get(
        ["categorySettings"],
        (result) => {

            let settings =
                result.categorySettings || {};

            document.getElementById("socialMedia").checked =
                settings.socialMedia?.enabled || false;

            document.getElementById("videoStreaming").checked =
                settings.videoStreaming?.enabled || false;

            document.getElementById("gaming").checked =
                settings.gaming?.enabled || false;

            document.getElementById("socialMediaPermanent").checked =
                settings.socialMedia?.permanent || false;

            document.getElementById("videoStreamingPermanent").checked =
                settings.videoStreaming?.permanent || false;

            document.getElementById("gamingPermanent").checked =
                settings.gaming?.permanent || false;
        }
    );

});

// Renders the saved task into the panel (called on page load)
function renderTask(task) {
    const taskRow = document.querySelector(".task-row");

    if (!task) return;

    taskRow.innerHTML = `
        <div class="saved-task">
            <p class="task-label">⏱ 60s COOLDOWN TIMER</p>
            <p class="task-message">"${task.message}"</p>
            <button class="task-btn remove-task-btn">Remove Task</button>
        </div>
    `;

    document.querySelector(".remove-task-btn")
        .addEventListener("click", () => {
            chrome.storage.local.set({ unlockTask: null }, () => {
                taskRow.innerHTML = addTaskButtonHTML();
                attachAddTaskListener();
            });
        });
}

// Returns the original "Add Task" button markup
function addTaskButtonHTML() {
    return `<button class="task-btn" id="addTaskBtn">Add task</button>`;
}

// Swaps the button for the task config form
function attachAddTaskListener() {
    document.getElementById("addTaskBtn")
        .addEventListener("click", () => {
            const taskRow = document.querySelector(".task-row");

            taskRow.innerHTML = `
                <div class="task-config">
                    <p class="task-label">⏱ 60s COOLDOWN TIMER</p>
                    <textarea
                        id="taskMessage"
                        placeholder="Message shown during countdown... (e.g. 'You set this block for a reason.')"
                        maxlength="200"
                    ></textarea>
                </div>
            `;
        });
}

// On load — restore task if one was saved
document.addEventListener("DOMContentLoaded", () => {
    chrome.storage.local.get(["categorySettings", "unlockTask"], (result) => {

        // ... your existing checkbox restore code stays here ...

        if (result.unlockTask) {
            renderTask(result.unlockTask);
        } else {
            attachAddTaskListener();
        }
    });
});