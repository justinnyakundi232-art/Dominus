// Read the original blocked URL from the query string
function getOriginalUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get("url");
}

const TEMP_UNLOCK_DURATION_MS = 60 * 60 * 1000; // 1 hour

// Per-domain, per-day unlock counts that drive cooldown escalation.
// Shape: { "youtube.com": { date: "YYYY-MM-DD", count: 2 }, ... }
const ESCALATION_KEY = "escalationState";

const mainHeading = document.getElementById("mainHeading");
const subtitle = document.getElementById("subtitle");
const taskArea = document.getElementById("taskArea");
const unlockBtn = document.getElementById("unlockBtn");
// The category list this page enforces. Before 1.8 it was a hardcoded object
// duplicated from BuildFortress.js; it now comes from storage via
// Categories.js, so a category the user renamed, re-stocked or invented is
// honoured here too.
//
// Read once and cached: every lookup below (permanence, task, cooldown) needs
// it, and it cannot change while this page is open.
let categoryDefs = [];

const categoriesReady = loadCategories().then(({ categories }) => {
    categoryDefs = categories;
    return categories;
});

let countdownInterval = null;
let visibilityHandler = null;
let originalUrl = getOriginalUrl();

// Bare hostname of the blocked site — the key for both tempUnlocks and the
// escalation counter. Null if the page was somehow opened without a ?url=.
function currentDomain() {
    return originalUrl
        ? new URL(originalUrl).hostname.replace(/^www\./, "")
        : null;
}

// "RETURN" / "STAY FOCUSED" button — always available, closes the tab
document.getElementById("focusBtn").addEventListener("click", async () => {
    // Feeds the Stay Focused/Unlock ratio only — never affects the streak.
    recordStayFocused();

    let [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    // Open a fresh tab first so closing this one never closes the whole window
    // if it happened to be the only tab open.
    await chrome.tabs.create({});
    chrome.tabs.remove(tab.id);
});

// Renders the initial "Complete Task to Unblock" button, or a disabled
// permanent-block message when a category holding this site is permanent.
//
// Permanence resolves most-restrictive across every category the site sits in
// (isPermanentDomain), so adding a site to a second, laxer category can't
// quietly reopen one that was sealed.
function renderCompleteTaskButton() {
    categoriesReady.then(() => {
        const domain = currentDomain();

        if (isPermanentDomain(categoryDefs, domain)) {
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
                    // The category's own task wins over the fortress-wide one
                    // when it declared an override.
                    beginTask(resolveTaskForDomain(
                        categoryDefs,
                        domain,
                        taskResult.unlockTask || null
                    ));
                });
            });
    });
}

// Names the category governing this site under the heading, so which standards
// apply is never a guess — particularly when a site sits in several categories
// and only the first one in the fortress list actually governs it.
function renderGoverningCategory() {
    categoriesReady.then(() => {
        const el = document.getElementById("categoryNote");
        if (!el) return;

        const category = governingCategory(categoryDefs, currentDomain());
        if (!category) return;

        const hasOwnStandards = ("task" in category) || Boolean(category.cooldown);

        // Built as nodes rather than innerHTML: the category name is user-typed
        // and has no business being parsed as markup.
        const badge = document.createElement("span");
        badge.className = "category-note-badge";
        badge.style.color = categoryColorValue(category);
        badge.textContent = category.glyph;

        const text = document.createElement("span");
        text.textContent = hasOwnStandards
            ? `Blocked under ${category.name} — this category sets its own terms.`
            : `Blocked under ${category.name}.`;

        el.textContent = "";
        el.appendChild(badge);
        el.appendChild(text);
    });
}

// Routes to the challenge for the configured task, or straight to the cooldown
// when there is none. An unrecognised type (a task saved by a newer version)
// falls through to the plain cooldown rather than leaving a dead button.
function beginTask(task) {
    if (!task) {
        return beginCooldown(null);
    }

    if (task.type === "cooldown") {
        return renderTypingChallenge({
            instruction: "Type the message below exactly to begin your cooldown:",
            target: task.message,
            // The user's own words carry through to the countdown as the heading.
            carryToHeading: true
        });
    }

    if (task.type === "passage") {
        return renderTypingChallenge({
            instruction: "Type this passage exactly to begin your cooldown:",
            target: generatePassage(),
            carryToHeading: false
        });
    }

    if (task.type === "code") {
        return renderCodeChallenge(task.code);
    }

    return beginCooldown(null);
}

// Shared "retype this text" challenge, used by both the reflection message and
// the random passage. Pasting is blocked — the target is on screen, so without
// that the whole task is one Ctrl+C away from meaningless.
function renderTypingChallenge({ instruction, target, carryToHeading }) {
    taskArea.innerHTML = `
        <div class="task-confirm-box">
            <p class="task-instruction">${escapeHtml(instruction)}</p>
            <p class="task-target-message">${escapeHtml(target)}</p>
            <textarea id="confirmInput" placeholder="Type it here..."></textarea>
            <p class="task-error" id="taskError"></p>
            <button id="confirmTaskBtn">CONFIRM</button>
        </div>
    `;

    const input = document.getElementById("confirmInput");
    blockPasteOn(input);

    document.getElementById("confirmTaskBtn")
        .addEventListener("click", () => {
            const errorEl = document.getElementById("taskError");

            if (input.value.trim() === target.trim()) {
                beginCooldown(carryToHeading ? target : null);
            } else {
                errorEl.textContent = "That doesn't match. Try again.";
            }
        });
}

// Guarded Code challenge. The code itself is never displayed here — the only
// copy the user can reach is the one they wrote down and walked away from.
function renderCodeChallenge(expectedCode) {
    // A task saved without a code (shouldn't happen, but storage is storage)
    // must not become an unopenable lock.
    if (!expectedCode) {
        return beginCooldown(null);
    }

    taskArea.innerHTML = `
        <div class="task-confirm-box">
            <p class="task-instruction">Enter the code you wrote down:</p>
            <textarea id="confirmInput" placeholder="Your code..."></textarea>
            <p class="task-error" id="taskError"></p>
            <button id="confirmTaskBtn">CONFIRM</button>
        </div>
    `;

    const input = document.getElementById("confirmInput");
    blockPasteOn(input);

    document.getElementById("confirmTaskBtn")
        .addEventListener("click", () => {
            const errorEl = document.getElementById("taskError");
            // Case-insensitive: the friction is fetching the paper, not
            // remembering whether it was written in capitals.
            const entered = input.value.trim().toUpperCase();

            if (entered === expectedCode.trim().toUpperCase()) {
                beginCooldown(null);
            } else {
                errorEl.textContent = "That code isn't right.";
            }
        });
}

// ---- Escalation state -----------------------------------------------------

// How many times this domain has already been unlocked today. Any entry from a
// previous day reads as 0, which is what makes the counter reset at midnight.
function getPriorUnlocks(domain) {
    return new Promise((resolve) => {
        if (!domain) return resolve(0);

        chrome.storage.local.get([ESCALATION_KEY], (result) => {
            const entry = (result[ESCALATION_KEY] || {})[domain];
            if (!entry || entry.date !== todayLocal()) return resolve(0);
            resolve(entry.count || 0);
        });
    });
}

// Counts an unlock against today's total for this domain. Entries from earlier
// days are dropped on the way through so the object can't grow without bound.
function recordEscalationUnlock(domain) {
    return new Promise((resolve) => {
        if (!domain) return resolve();

        chrome.storage.local.get([ESCALATION_KEY], (result) => {
            const today = todayLocal();
            const stored = result[ESCALATION_KEY] || {};
            const fresh = {};

            for (const key in stored) {
                if (stored[key] && stored[key].date === today) {
                    fresh[key] = stored[key];
                }
            }

            const count = fresh[domain] ? (fresh[domain].count || 0) : 0;
            fresh[domain] = { date: today, count: count + 1 };

            chrome.storage.local.set({ [ESCALATION_KEY]: fresh }, resolve);
        });
    });
}

// The cooldown that applies to *this* site: the governing category's override
// if it set one, otherwise the fortress-wide setting. Resolved the same way as
// the task but read separately, because the cooldown also runs when there is no
// task at all.
function getCooldownSettings() {
    return categoriesReady.then(() => new Promise((resolve) => {
        chrome.storage.local.get(["cooldownSettings"], (result) => {
            resolve(resolveCooldownForDomain(
                categoryDefs,
                currentDomain(),
                result.cooldownSettings
            ));
        });
    }));
}

// ---- Cooldown -------------------------------------------------------------

// Works out how long this particular cooldown should run, then starts it.
function beginCooldown(headingMessage) {
    const domain = currentDomain();

    Promise.all([getCooldownSettings(), getPriorUnlocks(domain)])
        .then(([cooldown, priorUnlocks]) => {
            const seconds = effectiveCooldownSeconds(cooldown, priorUnlocks);

            // Escalation is only a deterrent if the user can see it happening,
            // so say so rather than silently handing them a longer wait.
            const note = (cooldown.escalate && priorUnlocks > 0)
                ? `Unlock #${priorUnlocks + 1} of ${domain} today — cooldown raised to ${formatHuman(seconds)}.`
                : "";

            startCountdown(seconds, headingMessage, note);
        });
}

// Runs the countdown, then arms the unlock button.
//
// The clock only advances while the tab is actually visible: switching away
// pauses it rather than resetting it. Resetting would punish an accidental
// alt-tab or a notification stealing focus, which in practice just trains the
// user to disable the feature. visibilitychange (not window blur) is the right
// signal — blur also fires for a notification popup on a second monitor, where
// the page is still perfectly visible.
function startCountdown(totalSeconds, headingMessage, escalationNote) {
    taskArea.innerHTML = escalationNote
        ? `<p class="countdown-note">${escapeHtml(escalationNote)}</p>`
        : "";

    if (headingMessage) {
        mainHeading.textContent = headingMessage;
    }

    let remaining = totalSeconds;
    let paused = document.hidden;

    function updateDisplay() {
        subtitle.textContent = paused
            ? "PAUSED — RETURN TO THIS TAB"
            : formatClock(remaining);
    }

    visibilityHandler = () => {
        paused = document.hidden;
        updateDisplay();
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    updateDisplay();

    countdownInterval = setInterval(() => {
        if (paused) return;

        remaining--;

        if (remaining <= 0) {
            remaining = 0;
            stopCountdown();
            updateDisplay();
            activateUnlockButton();
        } else {
            updateDisplay();
        }
    }, 1000);
}

// Tears down both the interval and the visibility listener together, so a
// finished countdown can't leave a handler behind still rewriting the subtitle.
function stopCountdown() {
    clearInterval(countdownInterval);
    countdownInterval = null;

    if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
    }
}

// Switches the unlock button from disabled/faded to active/glowing
function activateUnlockButton() {
    unlockBtn.disabled = false;
    unlockBtn.classList.remove("disabled");
    unlockBtn.classList.add("ready");
}

// Handles the actual unlock: temporary window, then redirect to the original site
const unlockModal = document.getElementById("unlockModal");
const unlockModalText = document.getElementById("unlockModalText");
const unlockModalCancel = document.getElementById("unlockModalCancel");
const unlockModalConfirm = document.getElementById("unlockModalConfirm");

let pendingUnlockDomain = null;

// Assembles the confirmation copy: what's about to happen, what it costs in
// streak terms, and what the *next* unlock today would cost. Joined with blank
// lines and rendered via textContent (#unlockModalText is white-space:pre-line),
// so none of it can be interpreted as markup.
function buildUnlockModalText(domain) {
    return Promise.all([
        getStats(),
        getCooldownSettings(),
        getPriorUnlocks(domain)
    ]).then(([stats, cooldown, priorUnlocks]) => {
        const lines = [
            `You are about to unlock ${domain} for 1 hour. After that, it will be blocked again automatically.`
        ];

        // Suppressed at zero — "this breaks your 0-day streak" undercuts the
        // warning instead of reinforcing it.
        if (stats.currentStreak > 0) {
            const days = stats.currentStreak;
            lines.push(`This breaks your ${days}-day discipline streak.`);
        }

        if (cooldown.escalate) {
            const next = effectiveCooldownSeconds(cooldown, priorUnlocks + 1);
            lines.push(`Your next unlock of ${domain} today would cost a ${formatHuman(next)} cooldown.`);
        }

        lines.push("Are you sure?");
        return lines.join("\n\n");
    });
}

unlockBtn.addEventListener("click", () => {
    if (unlockBtn.disabled) return;
    if (!originalUrl) return;

    pendingUnlockDomain = currentDomain();

    buildUnlockModalText(pendingUnlockDomain).then((text) => {
        unlockModalText.textContent = text;
        unlockModal.hidden = false;
    });
});

unlockModalCancel.addEventListener("click", () => {
    unlockModal.hidden = true;
    pendingUnlockDomain = null;
});

unlockModalConfirm.addEventListener("click", () => {
    if (!pendingUnlockDomain) return;

    const domain = pendingUnlockDomain;
    const expiry = Date.now() + TEMP_UNLOCK_DURATION_MS;

    // Record the unlock for stats (separate `stats` key, so it runs alongside
    // the tempUnlocks write without conflicting): counts it and marks today
    // not-clean, breaking the streak. The domain goes with it so the day log
    // can name what gave way.
    recordUnlock(domain);

    // Counted separately from stats because escalation is per-domain and
    // per-day, where the streak is global and historical.
    recordEscalationUnlock(domain);

    chrome.storage.local.get(["tempUnlocks"], (result) => {
        let tempUnlocks = result.tempUnlocks || {};
        tempUnlocks[domain] = expiry;

        chrome.storage.local.set({ tempUnlocks: tempUnlocks }, async () => {
            unlockModal.hidden = true;
            let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            chrome.tabs.update(tab.id, { url: originalUrl });
        });
    });
});

// Fills the discipline-streak line from the stats layer. getStats() refreshes
// the streak first, so simply landing on the blocked page keeps today counted
// (as clean, until/unless the user unlocks).
function renderStreak() {
    getStats().then((stats) => {
        const el = document.getElementById("streakValue");
        if (!el) return;
        const days = stats.currentStreak;
        el.textContent = `${days} ${days === 1 ? "DAY" : "DAYS"}`;
    });
}

// Initial render on page load
renderCompleteTaskButton();
renderGoverningCategory();
renderStreak();