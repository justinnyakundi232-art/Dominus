// BuildFortress.js — the setup page.
//
// Two panels: the categories that decide *what* is blocked, and the standards
// that decide *what it costs* to unlock. Since 1.8 the category list is user
// data rather than a hardcoded literal (see Categories.js), and any category
// can carry its own task and cooldown instead of the fortress-wide ones.
//
// Everything here edits an in-memory working copy and only touches storage on
// SAVE FORTRESS, so a half-finished edit never becomes a live block.

// The working copy of the category list. Loaded once on DOMContentLoaded,
// mutated by the UI, and written back on save.
let categoryState = [];

// Domains blocked straight from the popup. This page never edits them, but it
// has to carry them through so the derived blockedSites doesn't drop them.
let manualSites = [];

// Which category detail panels are open. Held apart from the DOM so a re-render
// (after a save, or after adding a category) doesn't collapse what the user was
// working on.
let expandedCategories = new Set();

// Guarded Codes generated while a picker is open, keyed by scope ("fortress" or
// a category id). They only live here between "user picked Guarded Code" and
// "user hit save" — once saved the code lives in storage and is never displayed
// again, which is the entire point of the task.
let pendingGuardCodes = {};

// ---- Task picker ----------------------------------------------------------
// One implementation, used by the fortress-wide task and by every per-category
// override. Element ids are scoped so several pickers can be open at once
// without colliding.

function scopedId(scope, name) {
    return `${scope}__${name}`;
}

// Draws the picker into `container`. `savedTask` is whatever is currently
// stored for this scope — it preselects the dropdown and, for a Guarded Code,
// lets the picker say "already saved" instead of revealing the code.
function renderTaskPicker(container, scope, savedTask) {
    const options = TASK_TYPES
        .map((task) => {
            const selected = savedTask && savedTask.type === task.id ? " selected" : "";
            return `<option value="${task.id}"${selected}>${escapeHtml(task.title)}</option>`;
        })
        .join("");

    container.innerHTML = `
        <div class="task-config">
            <div class="task-picker">
                <select id="${scopedId(scope, "taskType")}">
                    <option value="">— No task —</option>
                    ${options}
                </select>
                <span class="info-tip" tabindex="0" role="button" aria-label="What does this task do?">(?)<span class="info-tooltip" role="tooltip" id="${scopedId(scope, "taskTooltip")}">Pick a task to see what it asks of you.</span></span>
            </div>
            <div id="${scopedId(scope, "taskConfig")}"></div>
        </div>
    `;

    const select = document.getElementById(scopedId(scope, "taskType"));

    select.addEventListener("change", () => {
        // Any change of selection abandons a code generated for the previous
        // one, so the draft can't leak into a task that isn't a Guarded Code.
        delete pendingGuardCodes[scope];
        renderTaskTypeConfig(scope, select.value, savedTask);
    });

    renderTaskTypeConfig(scope, select.value, savedTask);
}

// Draws the tooltip text and any extra fields for the selected task type.
function renderTaskTypeConfig(scope, typeId, savedTask) {
    const configEl = document.getElementById(scopedId(scope, "taskConfig"));
    const tooltipEl = document.getElementById(scopedId(scope, "taskTooltip"));
    const selected = getTaskType(typeId);

    tooltipEl.textContent = selected
        ? selected.tooltip
        : "No task — only the cooldown stands between you and the site.";

    if (typeId === "cooldown") {
        const saved = savedTask && savedTask.type === "cooldown" ? savedTask.message : "";
        configEl.innerHTML = `
            <textarea
                id="${scopedId(scope, "taskMessage")}"
                placeholder="Message you'll have to type back... (e.g. 'You set this block for a reason.')"
                maxlength="200"
            >${escapeHtml(saved)}</textarea>
        `;
        return;
    }

    if (typeId === "code") {
        // A code already saved for this scope is NOT re-displayed — showing it
        // again would mean the written copy never has to be fetched, which is
        // the whole task. The user can still deliberately replace it.
        if (savedTask && savedTask.type === "code" && savedTask.code && !pendingGuardCodes[scope]) {
            configEl.innerHTML = `
                <p class="guard-code-note">
                    A code is already saved for this scope. It is never shown again —
                    only the copy you wrote down can unlock.
                </p>
                <button type="button" class="task-btn" id="${scopedId(scope, "regenCode")}">
                    Generate a new code
                </button>
            `;

            document.getElementById(scopedId(scope, "regenCode"))
                .addEventListener("click", () => {
                    pendingGuardCodes[scope] = generateGuardCode();
                    renderTaskTypeConfig(scope, typeId, savedTask);
                });
            return;
        }

        // Generated here rather than at save time so the user can see it while
        // deciding, and copy it down before committing.
        if (!pendingGuardCodes[scope]) {
            pendingGuardCodes[scope] = generateGuardCode();
        }

        configEl.innerHTML = `
            <p class="guard-code">${pendingGuardCodes[scope]}</p>
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

// Reads an open picker into a task object.
// Returns undefined when this scope's picker isn't open, so the caller can tell
// "untouched, keep what was saved" apart from "explicitly set to no task"
// (which returns null).
function readTaskPicker(scope, savedTask) {
    const select = document.getElementById(scopedId(scope, "taskType"));
    if (!select) return undefined;

    const typeId = select.value;
    if (!typeId) return null;

    if (typeId === "cooldown") {
        const messageInput = document.getElementById(scopedId(scope, "taskMessage"));
        return {
            type: "cooldown",
            message: (messageInput ? messageInput.value.trim() : "")
                || "Take a breath. You set this block."
        };
    }

    if (typeId === "code") {
        // Falls back to the saved code when the user reopened the picker on an
        // existing Guarded Code without regenerating it.
        const code = pendingGuardCodes[scope]
            || (savedTask && savedTask.type === "code" ? savedTask.code : null);

        return { type: "code", code: code };
    }

    return { type: typeId };
}

// ---- Cooldown fields ------------------------------------------------------
// Also shared: the fortress-wide block and every per-category override are the
// same controls with the same floors, so they can't drift apart.

function renderCooldownBlock(container, scope, cooldown, heading) {
    const settings = normalizeCooldown(cooldown);

    container.innerHTML = `
        <p class="cooldown-heading">
            ${escapeHtml(heading)}
            <span class="info-tip" tabindex="0" role="button" aria-label="What is the cooldown?">(?)<span class="info-tooltip" role="tooltip">Time you must sit on the blocked page before UNLOCK SITE becomes clickable. The countdown pauses if you switch away from the tab, so it only runs while you are actually looking at it.</span></span>
        </p>

        <label class="cooldown-field">
            <span>Duration</span>
            <input type="number" id="${scopedId(scope, "cooldownMinutes")}" min="1" step="1" value="${Math.max(1, Math.round(settings.seconds / 60))}">
            <span>minutes</span>
        </label>

        <label class="cooldown-toggle">
            <input type="checkbox" id="${scopedId(scope, "cooldownEscalate")}"${settings.escalate ? " checked" : ""}>
            <span>
                Escalate on repeat unlocks
                <span class="info-tip" tabindex="0" role="button" aria-label="What is escalation?">(?)<span class="info-tooltip" role="tooltip">Each time you unlock the same site on the same day, its next cooldown is multiplied by this rate. The count resets at midnight, and the cooldown is capped at 60 minutes so you can never lock yourself out for good.</span></span>
            </span>
        </label>

        <label class="cooldown-field" id="${scopedId(scope, "cooldownFactorField")}">
            <span>Rate</span>
            <input type="number" id="${scopedId(scope, "cooldownFactor")}" min="${MIN_ESCALATION_FACTOR}" step="0.05" value="${settings.factor}">
            <span>&times; per unlock</span>
        </label>
    `;

    document.getElementById(scopedId(scope, "cooldownEscalate"))
        .addEventListener("change", () => syncEscalationField(scope));

    syncEscalationField(scope);
}

// The rate only means anything while escalation is on, so it follows the
// checkbox — same pattern as a category's "permanent" checkbox following its
// parent.
function syncEscalationField(scope) {
    const toggle = document.getElementById(scopedId(scope, "cooldownEscalate"));
    const field = document.getElementById(scopedId(scope, "cooldownFactorField"));
    const factor = document.getElementById(scopedId(scope, "cooldownFactor"));
    if (!toggle || !field || !factor) return;

    factor.disabled = !toggle.checked;
    field.classList.toggle("disabled-field", !toggle.checked);
}

function readCooldownBlock(scope) {
    const minutesEl = document.getElementById(scopedId(scope, "cooldownMinutes"));
    if (!minutesEl) return null;

    return normalizeCooldown({
        // The field is in minutes because the floor is one minute; storage is
        // in seconds because that's what the countdown ticks in.
        seconds: Number(minutesEl.value) * 60,
        escalate: document.getElementById(scopedId(scope, "cooldownEscalate")).checked,
        factor: Number(document.getElementById(scopedId(scope, "cooldownFactor")).value)
    });
}

// ---- Category list --------------------------------------------------------

function findCategory(id) {
    return categoryState.find((category) => category.id === id) || null;
}

// A one-line summary of what a category currently governs, shown on the
// collapsed row so the list stays readable without opening every panel.
function categorySummary(category) {
    const count = category.sites.length;
    const sites = `${count} ${count === 1 ? "site" : "sites"}`;

    if ("task" in category || category.cooldown) {
        return `${sites} · own standards`;
    }
    return `${sites} · fortress standards`;
}

function renderCategoryList() {
    const list = document.getElementById("categoryList");
    list.innerHTML = "";

    if (categoryState.length === 0) {
        list.innerHTML = `<p class="category-empty">No categories yet. Add one to group the sites you want walled off.</p>`;
        return;
    }

    // Two passes on purpose. renderTaskPicker and renderCooldownBlock look
    // their controls up with document.getElementById, which only finds an
    // element once it is in the document — so every block has to be attached
    // before any standards are rendered into it.
    const blocks = categoryState.map((category) => {
        const block = buildCategoryBlock(category);
        list.appendChild(block);
        return { block: block, category: category };
    });

    blocks.forEach(({ block, category }) => renderCategoryStandards(block, category));
}

// Fills in a category's task picker and cooldown fields, if it has standards of
// its own. Rendered even while the detail panel is collapsed: the panel is
// hidden rather than absent, so harvestCategories() can still read it.
function renderCategoryStandards(block, category) {
    const hasOwnStandards = ("task" in category) || Boolean(category.cooldown);
    if (!hasOwnStandards) return;

    renderTaskPicker(
        block.querySelector(".category-task"),
        category.id,
        "task" in category ? category.task : null
    );

    renderCooldownBlock(
        block.querySelector(".category-cooldown"),
        category.id,
        category.cooldown,
        "COOLDOWN FOR THIS CATEGORY"
    );
}

function buildCategoryBlock(category) {
    const expanded = expandedCategories.has(category.id);
    const hasOwnStandards = ("task" in category) || Boolean(category.cooldown);

    const block = document.createElement("div");
    block.className = "category-block";
    block.dataset.categoryId = category.id;

    // Held on the element rather than in a hidden input: the swatch buttons
    // write here, and harvestCategories() reads back from here, so the banner
    // survives a collapse without needing a form control to carry it.
    block.dataset.color = category.color;
    block.dataset.glyph = category.glyph;

    block.innerHTML = `
        <div class="category-row">
            <label class="category">
                <input type="checkbox" class="category-enable"${category.enabled ? " checked" : ""}>
                <span class="category-badge" style="color:${categoryColorValue(category)}">${category.glyph}</span>
                <span class="category-name">${escapeHtml(category.name)}</span>
            </label>
            <span class="category-summary">${escapeHtml(categorySummary(category))}</span>
            <button type="button" class="category-toggle" aria-expanded="${expanded}">
                ${expanded ? "▴" : "▾"}
            </button>
        </div>

        <div class="category-options">
            <label title="The blocked page will show no way to unlock this category. The only way to re-enable access is to come back here and uncheck this.">
                <input type="checkbox" class="category-permanent"${category.permanent ? " checked" : ""}${category.enabled ? "" : " disabled"}>
                Permanently Block (disables unlocks)
            </label>
        </div>

        <div class="category-detail"${expanded ? "" : " hidden"}>
            <label class="category-field">
                <span>Name</span>
                <input type="text" class="category-name-input" maxlength="${MAX_CATEGORY_NAME_LENGTH}" value="${escapeHtml(category.name)}">
            </label>

            <label class="category-field category-field-block">
                <span>Sites — one per line</span>
                <textarea class="category-sites" rows="5" placeholder="youtube.com">${escapeHtml(category.sites.join("\n"))}</textarea>
            </label>

            <div class="category-field category-field-block">
                <span>Banner</span>
                <div class="banner-row" role="group" aria-label="Category colour">
                    ${CATEGORY_COLORS.map((color) => `
                        <button type="button"
                            class="swatch${color.id === category.color ? " selected" : ""}"
                            data-color="${color.id}"
                            style="color:${color.value}"
                            title="${escapeHtml(color.name)}"
                            aria-label="${escapeHtml(color.name)}"
                            aria-pressed="${color.id === category.color}">●</button>
                    `).join("")}
                </div>
                <div class="banner-row" role="group" aria-label="Category mark">
                    ${CATEGORY_GLYPHS.map((glyph) => `
                        <button type="button"
                            class="glyph-option${glyph === category.glyph ? " selected" : ""}"
                            data-glyph="${glyph}"
                            aria-label="Mark ${glyph}"
                            aria-pressed="${glyph === category.glyph}">${glyph}</button>
                    `).join("")}
                </div>
            </div>

            <label class="cooldown-toggle category-standards-toggle">
                <input type="checkbox" class="category-own-standards"${hasOwnStandards ? " checked" : ""}>
                <span>
                    Give this category its own standards
                    <span class="info-tip" tabindex="0" role="button" aria-label="What are own standards?">(?)<span class="info-tooltip" role="tooltip">Overrides the fortress-wide task and cooldown for these sites only. If a site sits in more than one category, the highest category in this list is the one that governs it.</span></span>
                </span>
            </label>

            <div class="category-standards"${hasOwnStandards ? "" : " hidden"}>
                <div class="category-task"></div>
                <div class="cooldown-block category-cooldown"></div>
            </div>

            <button type="button" class="category-delete">Delete category</button>
        </div>
    `;

    wireCategoryBlock(block, category);
    return block;
}

function wireCategoryBlock(block, category) {
    const enableEl = block.querySelector(".category-enable");
    const permanentEl = block.querySelector(".category-permanent");

    // Unchecking a category clears and disables its permanent option, so a
    // stale "permanent" setting can't silently re-apply next time it's ticked.
    enableEl.addEventListener("change", () => {
        if (!enableEl.checked) permanentEl.checked = false;
        permanentEl.disabled = !enableEl.checked;
    });

    // Banner pickers. These repaint the row badge in place instead of going
    // through renderCategoryList(), so choosing a colour doesn't blur whatever
    // field the user was typing in.
    const badge = block.querySelector(".category-badge");

    function repaintBadge() {
        const value = categoryColorValue({ color: block.dataset.color });
        badge.style.color = value;
        badge.textContent = block.dataset.glyph;
        block.querySelectorAll(".glyph-option")
            .forEach((option) => { option.style.color = value; });
    }

    function selectOption(buttons, chosen) {
        buttons.forEach((button) => {
            const isChosen = button === chosen;
            button.classList.toggle("selected", isChosen);
            button.setAttribute("aria-pressed", String(isChosen));
        });
    }

    const swatches = [...block.querySelectorAll(".swatch")];
    swatches.forEach((swatch) => {
        swatch.addEventListener("click", () => {
            block.dataset.color = swatch.dataset.color;
            selectOption(swatches, swatch);
            repaintBadge();
        });
    });

    const glyphOptions = [...block.querySelectorAll(".glyph-option")];
    glyphOptions.forEach((option) => {
        option.addEventListener("click", () => {
            block.dataset.glyph = option.dataset.glyph;
            selectOption(glyphOptions, option);
            repaintBadge();
        });
    });

    repaintBadge();

    block.querySelector(".category-toggle").addEventListener("click", () => {
        // Harvest before re-rendering, or edits typed into an open panel would
        // be thrown away by the redraw.
        harvestCategories();

        if (expandedCategories.has(category.id)) {
            expandedCategories.delete(category.id);
        } else {
            expandedCategories.add(category.id);
        }
        renderCategoryList();
    });

    const ownStandardsEl = block.querySelector(".category-own-standards");
    ownStandardsEl.addEventListener("change", () => {
        const saved = findCategory(category.id);

        // Turning the override off on a category that has a saved task is the
        // one-click equivalent of removing a task, so it goes through the same
        // gate. Editing it inside the picker stays ungated, exactly as the
        // fortress-wide picker already works.
        if (!ownStandardsEl.checked && saved && saved.task) {
            openRemoveTaskModal(
                saved.task,
                `Drop ${saved.name}'s own standards? These sites fall back to the fortress-wide task and cooldown.`,
                () => {
                    harvestCategories();
                    const target = findCategory(category.id);
                    if (target) {
                        delete target.task;
                        delete target.cooldown;
                    }
                    delete pendingGuardCodes[category.id];
                    renderCategoryList();
                },
                () => {
                    ownStandardsEl.checked = true;
                }
            );
            return;
        }

        harvestCategories();
        const target = findCategory(category.id);
        if (target) {
            if (ownStandardsEl.checked) {
                if (!("task" in target)) target.task = null;
                if (!target.cooldown) target.cooldown = normalizeCooldown(null);
            } else {
                delete target.task;
                delete target.cooldown;
                delete pendingGuardCodes[category.id];
            }
        }
        renderCategoryList();
    });

    block.querySelector(".category-delete").addEventListener("click", () => {
        harvestCategories();
        requestCategoryDelete(category.id);
    });
}

// Reads every category block in the DOM back into categoryState. Called before
// any re-render and before saving, so nothing typed is lost to a redraw.
function harvestCategories() {
    document.querySelectorAll(".category-block").forEach((block) => {
        const category = findCategory(block.dataset.categoryId);
        if (!category) return;

        category.enabled = block.querySelector(".category-enable").checked;
        category.permanent = category.enabled
            && block.querySelector(".category-permanent").checked;

        // Always present, open panel or not — the pickers write to the block's
        // dataset rather than to a control inside the collapsible detail.
        category.color = block.dataset.color;
        category.glyph = block.dataset.glyph;

        // The detail fields only exist while the panel is open.
        const nameInput = block.querySelector(".category-name-input");
        if (nameInput) {
            category.name = nameInput.value.trim().slice(0, MAX_CATEGORY_NAME_LENGTH)
                || category.name;
        }

        const sitesInput = block.querySelector(".category-sites");
        if (sitesInput) {
            category.sites = parseSiteList(sitesInput.value);
        }

        const ownStandardsEl = block.querySelector(".category-own-standards");
        if (ownStandardsEl && ownStandardsEl.checked) {
            const task = readTaskPicker(
                category.id,
                "task" in category ? category.task : null
            );
            if (task !== undefined) category.task = task;

            const cooldown = readCooldownBlock(category.id);
            if (cooldown) category.cooldown = cooldown;
        }
    });
}

// ---- Adding a category ----------------------------------------------------

document.getElementById("addCategoryBtn").addEventListener("click", () => {
    harvestCategories();

    // Banner assigned by position so consecutive new categories don't all come
    // out the same colour; the user can still change it in the panel below.
    const appearance = defaultAppearance(categoryState.length);

    const category = {
        id: `custom-${Date.now()}-${categoryState.length}`,
        name: "New category",
        sites: [],
        enabled: false,
        permanent: false,
        color: appearance.color,
        glyph: appearance.glyph
    };

    categoryState.push(category);
    // Open it straight away: a new category with no sites in it does nothing,
    // so the next thing the user needs is the editor.
    expandedCategories.add(category.id);
    renderCategoryList();

    const input = document.querySelector(
        `.category-block[data-category-id="${category.id}"] .category-name-input`
    );
    if (input) {
        input.focus();
        input.select();
    }
});

// ---- Category-deletion friction gate --------------------------------------
// Deleting a category that is switched on takes live blocks down with it, so it
// gets the same treatment as removing a block or a task: name what's being
// given up, show the streak at stake, hold the button shut. A category that
// isn't switched on isn't blocking anything, so it just goes.

const removeCategoryModal = document.getElementById("removeCategoryModal");
const removeCategoryModalStreak = document.getElementById("removeCategoryModalStreak");
const removeCategoryModalText = document.getElementById("removeCategoryModalText");
const removeCategoryModalCancel = document.getElementById("removeCategoryModalCancel");
const removeCategoryModalConfirm = document.getElementById("removeCategoryModalConfirm");

let pendingDeleteCategoryId = null;
let removeCategoryCountdownInterval = null;

function requestCategoryDelete(categoryId) {
    const category = findCategory(categoryId);
    if (!category) return;

    if (!category.enabled) {
        deleteCategory(categoryId);
        return;
    }

    pendingDeleteCategoryId = categoryId;

    const count = category.sites.length;
    const permanentNote = category.permanent
        ? " This category is set to permanently blocked."
        : "";

    removeCategoryModalText.textContent =
        `Delete ${category.name}? ${count} ${count === 1 ? "site" : "sites"} `
        + `will stop being blocked, unless another category also covers them.${permanentNote}`;

    removeCategoryModalStreak.textContent = "";
    getStats().then((stats) => {
        if (removeCategoryModal.hidden) return;
        if (stats.currentStreak > 0) {
            const days = stats.currentStreak;
            removeCategoryModalStreak.textContent =
                `You're on a ${days}-day discipline streak — this is part of the wall protecting it.`;
        }
    });

    removeCategoryModal.hidden = false;
    startModalCooldown(removeCategoryModalConfirm, "DELETE CATEGORY", (interval) => {
        removeCategoryCountdownInterval = interval;
    });
}

function closeRemoveCategoryModal() {
    clearInterval(removeCategoryCountdownInterval);
    removeCategoryModal.hidden = true;
    pendingDeleteCategoryId = null;
}

removeCategoryModalCancel.addEventListener("click", closeRemoveCategoryModal);

removeCategoryModalConfirm.addEventListener("click", () => {
    if (removeCategoryModalConfirm.disabled || !pendingDeleteCategoryId) return;
    const id = pendingDeleteCategoryId;
    closeRemoveCategoryModal();
    deleteCategory(id);
});

function deleteCategory(categoryId) {
    categoryState = categoryState.filter((category) => category.id !== categoryId);
    expandedCategories.delete(categoryId);
    delete pendingGuardCodes[categoryId];
    renderCategoryList();
}

// Shared countdown for every confirm button on this page: locks it, ticks down,
// then arms it. Hands the interval id back so each caller can clear its own.
function startModalCooldown(button, readyLabel, onInterval) {
    let remaining = REMOVE_COOLDOWN_SECONDS;

    button.disabled = true;
    button.classList.add("disabled");
    button.textContent = `CONFIRM (${remaining})`;

    const interval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(interval);
            button.disabled = false;
            button.classList.remove("disabled");
            button.textContent = readyLabel;
        } else {
            button.textContent = `CONFIRM (${remaining})`;
        }
    }, 1000);

    onInterval(interval);
}

// ---- Fortress-wide task panel ---------------------------------------------

// Renders whichever of the two states the panel should be in: a summary of the
// saved task, or the "Add task" button when there is none.
function renderTaskPanel(task) {
    const taskRow = document.querySelector(".task-row");
    delete pendingGuardCodes.fortress;

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
            openRemoveTaskModal(
                task,
                task.type === "code"
                    ? `Remove your ${getTaskTitle(task.type)} task? The saved code is discarded for good — the copy you wrote down will stop working, and a new task means a new code.`
                    : `Remove your ${getTaskTitle(task.type)} task? Unlocking a blocked site will only require the cooldown after this.`,
                () => {
                    // The one edit on this page that commits the moment it is
                    // confirmed rather than waiting for SAVE FORTRESS, which is
                    // how Remove Task has always behaved. It now goes through
                    // the same chokepoint as everything else.
                    commitFortress({ task: null }).then((outcome) => {
                        if (outcome.saved) renderTaskPanel(null);
                    });
                }
            );
        });
}

// Swaps the "Add task" button for the picker.
function attachAddTaskListener() {
    document.getElementById("addTaskBtn")
        .addEventListener("click", () => {
            renderTaskPicker(document.querySelector(".task-row"), "fortress", null);
        });
}

// ---- Task-removal friction gate -------------------------------------------
// Deleting a task here used to be one click, which quietly undid whatever
// gauntlet the blocked page was supposed to put up — a Guarded Code you'd
// walked across the house to fetch could be erased in less time than it took
// to fetch it.
//
// The point isn't to trap anyone. Dominus can be uninstalled, and it should be
// possible to drop a task you no longer want. It's to make sure that choice is
// made by the version of you that's thinking, not the one that's reaching.
//
// Since 1.8 it also serves the per-category overrides, so `onConfirm` and
// `onCancel` are supplied by the caller rather than hardcoded to the
// fortress-wide task.

const removeTaskModal = document.getElementById("removeTaskModal");
const removeTaskModalStreak = document.getElementById("removeTaskModalStreak");
const removeTaskModalText = document.getElementById("removeTaskModalText");
const removeTaskModalCancel = document.getElementById("removeTaskModalCancel");
const removeTaskModalConfirm = document.getElementById("removeTaskModalConfirm");

let removeTaskCountdownInterval = null;
let pendingTaskRemoval = null;
let pendingTaskRemovalCancel = null;

function openRemoveTaskModal(task, message, onConfirm, onCancel) {
    pendingTaskRemoval = onConfirm;
    pendingTaskRemovalCancel = onCancel || null;

    removeTaskModalText.textContent = message;

    removeTaskModalStreak.textContent = "";
    getStats().then((stats) => {
        // Guard against the modal being closed before this resolves.
        if (removeTaskModal.hidden) return;
        if (stats.currentStreak > 0) {
            const days = stats.currentStreak;
            removeTaskModalStreak.textContent =
                `You're on a ${days}-day discipline streak — this is the wall you built to protect it.`;
        }
    });

    removeTaskModal.hidden = false;
    startModalCooldown(removeTaskModalConfirm, "REMOVE TASK", (interval) => {
        removeTaskCountdownInterval = interval;
    });
}

function closeRemoveTaskModal() {
    clearInterval(removeTaskCountdownInterval);
    removeTaskModal.hidden = true;
    pendingTaskRemoval = null;
    pendingTaskRemovalCancel = null;
}

removeTaskModalCancel.addEventListener("click", () => {
    // The cancel path has to be able to put a checkbox back, so it runs before
    // the handlers are cleared.
    if (pendingTaskRemovalCancel) pendingTaskRemovalCancel();
    closeRemoveTaskModal();
});

removeTaskModalConfirm.addEventListener("click", () => {
    if (removeTaskModalConfirm.disabled || !pendingTaskRemoval) return;
    const confirmed = pendingTaskRemoval;
    // Cleared before running so a re-render triggered by the callback can't
    // re-enter this handler.
    pendingTaskRemoval = null;
    pendingTaskRemovalCancel = null;
    closeRemoveTaskModal();
    confirmed();
});

// ---- Save -----------------------------------------------------------------

document.querySelector(".save-btn").addEventListener("click", () => {
    harvestCategories();

    chrome.storage.local.get(["unlockTask", "cooldownSettings"], (result) => {
        // readTaskPicker returns undefined when the picker isn't open. That's
        // deliberately distinct from null: undefined means "the user never
        // touched the task, keep whatever was saved", null means "the user
        // opened the picker and chose no task", which should clear it.
        const formTask = readTaskPicker("fortress", result.unlockTask || null);

        const taskToSave = formTask === undefined
            ? (result.unlockTask || null)
            : formTask;

        // Null when the fields haven't rendered yet — saving that fast would
        // otherwise overwrite a real cooldown with the defaults.
        const cooldownToSave = readCooldownBlock("fortress")
            || normalizeCooldown(result.cooldownSettings);

        // Everything this page can change goes to storage in one commit, which
        // is also where the seal is charged: commitFortress() works out whether
        // this save takes any defence down and asks for the seal if it does.
        // blockedSites is derived in there rather than here.
        commitFortress({
            categories: categoryState,
            manualSites: manualSites,
            task: taskToSave,
            cooldown: cooldownToSave
        }).then((outcome) => {
            if (!outcome.saved) return reportSaveRefused();

            // Every draft code is now committed to storage, so the pending map
            // is dropped: from here on a Guarded Code is saved, and the pickers
            // must stop showing it.
            pendingGuardCodes = {};

            // Collapse the pickers back down to a summary of what was just
            // saved, so the panel never sits in a half-edited state that
            // disagrees with storage.
            renderTaskPanel(taskToSave);
            renderCooldownBlock(
                document.getElementById("fortressCooldown"),
                "fortress",
                cooldownToSave,
                "COOLDOWN"
            );
            renderCategoryList();

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

// A save the seal turned down. Nothing was written, and — just as importantly
// — nothing on the page is reverted: every edit is still in the form, so the
// user can enter their seal and try again, or undo the part they didn't mean.
function reportSaveRefused() {
    const saveBtn = document.querySelector(".save-btn");
    const original = saveBtn.textContent;

    saveBtn.textContent = "NOT SAVED — SEAL REQUIRED";
    saveBtn.disabled = true;
    setTimeout(() => {
        saveBtn.textContent = original;
        saveBtn.disabled = false;
    }, 2000);
}

// ---- Load -----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    loadCategories().then(({ categories, manualSites: manual }) => {
        categoryState = categories;
        manualSites = manual;
        renderCategoryList();
    });

    chrome.storage.local.get(["unlockTask", "cooldownSettings"], (result) => {
        renderTaskPanel(result.unlockTask || null);
        renderCooldownBlock(
            document.getElementById("fortressCooldown"),
            "fortress",
            result.cooldownSettings,
            "COOLDOWN"
        );
    });
});
