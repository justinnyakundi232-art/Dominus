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
        // readTaskForm() returns undefined when the picker isn't open. That's
        // deliberately distinct from null: undefined means "the user never
        // touched the task, keep whatever was saved", null means "the user
        // opened the picker and chose no task", which should clear it.
        const formTask = readTaskForm();

        const taskToSave = formTask === undefined
            ? (result.unlockTask || null)
            : formTask;

        // The cooldown inputs are static markup, always present, so unlike the
        // task they're read unconditionally on every save.
        const cooldownToSave = readCooldownForm();

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
            unlockTask: taskToSave,
            cooldownSettings: cooldownToSave
        }, () => {
            // Collapse the picker back down to a summary of what was just
            // saved, so the panel never sits in a half-edited state that
            // disagrees with storage.
            renderTaskPanel(taskToSave);
            applyCooldownToForm(cooldownToSave);

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

// ---- Task panel -----------------------------------------------------------

// Holds the code generated for a Guarded Code task while the picker is open.
// It only exists between "user picked Guarded Code" and "user hit save" — once
// saved it lives in storage and is never displayed again.
let pendingGuardCode = null;

// Renders whichever of the two states the panel should be in: a summary of the
// saved task, or the "Add task" button when there is none.
function renderTaskPanel(task) {
    const taskRow = document.querySelector(".task-row");
    pendingGuardCode = null;

    if (!task) {
        taskRow.innerHTML = `<button class="task-btn" id="addTaskBtn">Add task</button>`;
        attachAddTaskListener();
        return;
    }

    // Per-type detail line. The Guarded Code is deliberately NOT shown — if the
    // panel would hand it back on demand, walking to fetch the paper copy stops
    // being necessary and the task is worthless.
    let detail = "";
    if (task.type === "cooldown") {
        detail = `<p class="task-message">"${escapeHtml(task.message)}"</p>`;
    } else if (task.type === "passage") {
        detail = `<p class="task-message">A fresh passage is generated each time.</p>`;
    } else if (task.type === "code") {
        detail = `<p class="task-message">Code hidden. Only your written copy can unlock now.</p>`;
    }

    taskRow.innerHTML = `
        <div class="saved-task">
            <p class="task-label">${escapeHtml(getTaskTitle(task.type))}</p>
            ${detail}
            <button class="task-btn remove-task-btn">Remove Task</button>
        </div>
    `;

    // Order matters: .remove-task-btn only exists in the DOM after the
    // innerHTML line above runs. Querying for it any earlier would return
    // null, and calling .addEventListener on null throws immediately.
    document.querySelector(".remove-task-btn")
        .addEventListener("click", () => {
            chrome.storage.local.set({ unlockTask: null }, () => {
                renderTaskPanel(null);
            });
        });
}

// Swaps the "Add task" button for the picker.
function attachAddTaskListener() {
    document.getElementById("addTaskBtn")
        .addEventListener("click", () => {
            const taskRow = document.querySelector(".task-row");

            const options = TASK_TYPES
                .map((task) => `<option value="${task.id}">${escapeHtml(task.title)}</option>`)
                .join("");

            taskRow.innerHTML = `
                <div class="task-config">
                    <div class="task-picker">
                        <select id="taskType">
                            <option value="">— No task —</option>
                            ${options}
                        </select>
                        <span class="info-tip" id="taskTypeTip" tabindex="0" role="button" aria-label="What does this task do?">(?)<span class="info-tooltip" role="tooltip" id="taskTypeTooltip">Pick a task to see what it asks of you.</span></span>
                    </div>
                    <div id="taskTypeConfig"></div>
                </div>
            `;

            const select = document.getElementById("taskType");
            select.addEventListener("change", () => {
                renderTaskTypeConfig(select.value);
            });

            renderTaskTypeConfig("");
        });
}

// Draws the tooltip text and any extra fields for the selected task type.
function renderTaskTypeConfig(typeId) {
    const configEl = document.getElementById("taskTypeConfig");
    const tooltipEl = document.getElementById("taskTypeTooltip");
    const selected = getTaskType(typeId);

    tooltipEl.textContent = selected
        ? selected.tooltip
        : "No task — only the cooldown below stands between you and the site.";

    pendingGuardCode = null;

    if (typeId === "cooldown") {
        configEl.innerHTML = `
            <textarea
                id="taskMessage"
                placeholder="Message you'll have to type back... (e.g. 'You set this block for a reason.')"
                maxlength="200"
            ></textarea>
        `;
        return;
    }

    if (typeId === "code") {
        // Generated here rather than at save time so the user can see it while
        // deciding, and copy it down before committing.
        pendingGuardCode = generateGuardCode();
        configEl.innerHTML = `
            <p class="guard-code">${pendingGuardCode}</p>
            <p class="guard-code-note">
                Write this down and put it somewhere you'd have to get up to reach.
                It will not be shown again after you save.
            </p>
        `;
        return;
    }

    // "passage" needs no configuration, and "" (no task) needs no fields.
    configEl.innerHTML = typeId === "passage"
        ? `<p class="guard-code-note">Nothing to set up — a new passage is generated at each unlock.</p>`
        : "";
}

// Reads the open picker into a task object.
// Returns undefined when the picker isn't open, so the caller can tell
// "untouched" apart from "explicitly set to no task" (which returns null).
function readTaskForm() {
    const select = document.getElementById("taskType");
    if (!select) return undefined;

    const typeId = select.value;
    if (!typeId) return null;

    if (typeId === "cooldown") {
        const messageInput = document.getElementById("taskMessage");
        return {
            type: "cooldown",
            message: messageInput.value.trim() || "Take a breath. You set this block."
        };
    }

    if (typeId === "code") {
        return { type: "code", code: pendingGuardCode };
    }

    return { type: typeId };
}

// ---- Cooldown block -------------------------------------------------------

function readCooldownForm() {
    const minutes = Number(document.getElementById("cooldownMinutes").value);

    return normalizeCooldown({
        // The field is in minutes because the floor is one minute; storage is
        // in seconds because that's what the countdown ticks in.
        seconds: minutes * 60,
        escalate: document.getElementById("cooldownEscalate").checked,
        factor: Number(document.getElementById("cooldownFactor").value)
    });
}

function applyCooldownToForm(cooldown) {
    const settings = normalizeCooldown(cooldown);

    document.getElementById("cooldownMinutes").value =
        Math.max(1, Math.round(settings.seconds / 60));
    document.getElementById("cooldownEscalate").checked = settings.escalate;
    document.getElementById("cooldownFactor").value = settings.factor;

    syncEscalationField();
}

// The rate only means anything while escalation is on, so it follows the
// checkbox — same pattern as the per-category "permanent" checkboxes above.
function syncEscalationField() {
    const enabled = document.getElementById("cooldownEscalate").checked;
    const field = document.getElementById("cooldownFactorField");

    document.getElementById("cooldownFactor").disabled = !enabled;
    field.classList.toggle("disabled-field", !enabled);
}

// On load — restore the saved task and cooldown.
// This is a SEPARATE DOMContentLoaded listener from the one above that
// restores the category checkboxes — both fire in the order they were
// registered when the page loads, they don't conflict, but they could
// have been merged into one listener instead of two.
document.addEventListener("DOMContentLoaded", () => {
    chrome.storage.local.get(["unlockTask", "cooldownSettings"], (result) => {
        renderTaskPanel(result.unlockTask || null);
        applyCooldownToForm(result.cooldownSettings);

        document.getElementById("cooldownEscalate")
            .addEventListener("change", syncEscalationField);
    });
});

