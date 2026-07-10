// Master list of sites per category. When a category checkbox is checked,
// every site in its array gets added to blockedSites; when unchecked,
// every site in its array gets removed. This is the single source of
// truth both blocks below (add-on-check / delete-on-uncheck) read from.
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

    // result only contains the two keys we asked for:
    // result.blockedSites -> array of site strings saved last time (or missing)
    // result.unlockTask   -> the saved cooldown task object, or null/missing
    chrome.storage.local.get(["blockedSites", "unlockTask"], (result) => {
        const messageInput = document.getElementById("taskMessage");

        // messageInput only exists in the DOM while the "Add Task" form is
        // open. If it's open, build a fresh task from whatever was typed
        // (falling back to a default message for an empty textarea).
        // If the form is closed, messageInput is null (falsy), so we fall
        // back to whatever task was already saved instead of wiping it out.
        const taskToSave = messageInput
        ? { type: "cooldown", message: messageInput.value.trim() || "Take a breath. You set this block." }
        : (result.unlockTask || null);  // keep existing task if form isn't open

        // Using a Set (not a plain array) here matters: .add() is a no-op
        // if the site is already in the set, so saving multiple times while
        // a category stays checked never creates duplicate entries. It also
        // gives us a clean .delete(site) below instead of manual
        // indexOf + splice bookkeeping.
        let blockedSites = new Set(
            result.blockedSites || []
        );

        let categorySettings = {};

        // Pattern repeated for each of the 3 categories below:
        // - checked   -> record the category's enabled/permanent state and
        //                add all of its sites to the blocked set.
        // - unchecked -> remove all of its sites from the blocked set.
        // (=== false is used instead of a plain else because a checkbox's
        // .checked is always a real boolean, never undefined/null here, so
        // it's equivalent to else — just written more explicitly.)
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
        
        // Set(...) -> [...blockedSites] converts back to a plain array,
        // since chrome.storage can't store a Set object directly.
        // Note: .set()'s callback receives no arguments (unlike .get()) —
        // it only signals that the write finished.
        chrome.storage.local.set({
            blockedSites: [...blockedSites],
            categorySettings: categorySettings,
            unlockTask: taskToSave
        }, () => {
            const saveBtn = document.querySelector(".save-btn");
            // Captured here (not hardcoded) so the button reverts to
            // whatever text it actually had before, not an assumed value.
            // The setTimeout callback below is a closure — it still has
            // access to `original` 2 seconds later even though this outer
            // function has already finished running.
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

// Keeps a category's "Permanently Block" checkbox in sync with its parent —
// unchecking the category clears and disables the permanent option so a
// stale "permanent" setting can't silently re-apply next time it's saved.
function wireCategoryToggle(categoryId, permanentId) {
    const categoryCheckbox = document.getElementById(categoryId);
    const permanentCheckbox = document.getElementById(permanentId);

    categoryCheckbox.addEventListener("change", () => {
        if (!categoryCheckbox.checked) {
            permanentCheckbox.checked = false;
        }
        permanentCheckbox.disabled = !categoryCheckbox.checked;
    });
}

// Restores the 3 category checkboxes (and their "permanent" checkboxes)
// from whatever was last saved, then wires up the change listeners.
document.addEventListener("DOMContentLoaded", () => {

    chrome.storage.local.get(
        ["categorySettings"],
        (result) => {

            let settings =
                result.categorySettings || {};

            // settings.socialMedia?.enabled -> if settings.socialMedia
            // doesn't exist (e.g. first-ever load), the ?. short-circuits
            // to undefined instead of throwing "Cannot read properties of
            // undefined". The || false then turns that undefined into an
            // actual boolean the checkbox can use.
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

            wireCategoryToggle("socialMedia", "socialMediaPermanent");
            wireCategoryToggle("videoStreaming", "videoStreamingPermanent");
            wireCategoryToggle("gaming", "gamingPermanent");
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

    // Order matters: .remove-task-btn only exists in the DOM after the
    // innerHTML line above runs. Querying for it any earlier would return
    // null, and calling .addEventListener on null throws immediately.
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

// On load — restore task if one was saved.
// This is a SEPARATE DOMContentLoaded listener from the one above that
// restores the category checkboxes — both fire in the order they were
// registered when the page loads, they don't conflict, but they could
// have been merged into one listener instead of two.
document.addEventListener("DOMContentLoaded", () => {
    chrome.storage.local.get(["categorySettings", "unlockTask"], (result) => {
        if (result.unlockTask) {
            renderTask(result.unlockTask);
        } else {
            attachAddTaskListener();
        }
    });
});

