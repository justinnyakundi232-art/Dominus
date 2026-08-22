// Seal.js — the seal: a password on anything that weakens the fortress.
//
// Loaded by the popup and Build Fortress (and, for the recovery notice, the
// blocked page), so all of them agree on what the seal is, what counts as
// weakening, and how a fortress edit is committed.
//
// Dependency-free classic script, same contract as Tasks.js and Categories.js:
// every function is declared at the top level, nothing touches storage or the
// DOM at load time, and it is safe to include from any page in any order. It
// reads helpers from Tasks.js (normalizeCooldown, formatHuman, getTaskTitle)
// and Categories.js (computeBlockedSites, the storage keys) inside functions,
// so both must be loaded alongside it — but not necessarily first.
//
// Design note — the rule:
//
//     Strengthening the fortress is free. Weakening it costs the seal.
//
// Blocking a site, adding a category, lengthening a cooldown and raising your
// standards never prompt for anything. Friction on the way in kills adoption;
// friction on the way out is the entire point of Dominus. Which is why the
// seal is not attached to a page — it is attached to a *direction*. Everything
// that can move the fortress in the weaker direction goes through
// commitFortress() below, and nothing else writes those keys.
//
// Design note — what this is not:
//
// It is not a lock, and the copy never claims otherwise. chrome.storage.local
// is writable from DevTools and chrome://extensions removes the extension in
// two clicks, so a determined user is out either way — the same thing
// REMOVE_COOLDOWN_SECONDS already says about the ten-second gates. What the
// seal defends against is you at 11pm, and someone else idly poking at your
// machine. Ten seconds was already enough to beat the first of those most of
// the time; a password is the same idea with more weight behind it.
//
// The password is still hashed rather than stored, and that part is not
// theatre: people reuse passwords, so a plaintext verifier sitting in storage
// would leak a real credential to anything with disk access — and would be
// legible at a glance in DevTools, which defeats even the impulse-level job.

// ---- Storage keys ---------------------------------------------------------

// The seal itself. Absent (or enabled:false) means the fortress is unsealed,
// which is what every fortress that has never used the feature looks like —
// so unlike 1.8's category model, there is nothing here to migrate.
const SEAL_KEY = "seal";

// Failed attempts, kept apart from the seal so a wrong guess never rewrites
// the verifier. MUST live in storage rather than in a variable: the popup is
// destroyed every time it closes, so an in-memory counter is defeated by
// pressing Escape and clicking the icon again.
const SEAL_ATTEMPTS_KEY = "sealAttempts";

// ---- Limits ---------------------------------------------------------------

// Four characters. This guards against your own impulse, not against a
// dictionary attack — and a seal long enough to resist one gets written on a
// sticky note next to the machine, which is strictly worse.
const SEAL_MIN_LENGTH = 4;
const MAX_SEAL_HINT_LENGTH = 60;

const SEAL_ALGORITHM = "PBKDF2-SHA256";
const SEAL_ITERATIONS = 250000;

// How long "I forgot my seal" takes to lift it. Long enough that it cannot be
// used as a way around the prompt in the moment, short enough that forgetting
// isn't a catastrophe. There is deliberately no master code and no back door:
// one would be found, and it would make the changelog a lie.
const SEAL_RECOVERY_MS = 60 * 60 * 1000; // 1 hour

// Typing your own password wrong twice is a typo, not an attack, so the first
// two failures cost nothing. After that the wait doubles each time — the same
// escalation idea effectiveCooldownSeconds() uses for repeat unlocks.
const SEAL_FREE_ATTEMPTS = 2;
const SEAL_LOCKOUT_BASE_SECONDS = 5;
const SEAL_LOCKOUT_FACTOR = 2;

// Ceiling, for the same reason MAX_COOLDOWN_SECONDS exists: past a few minutes
// a wait stops being friction and becomes a lockout, and the recovery path is
// the honest way out of a forgotten seal — not an unbounded 2^n.
const MAX_SEAL_LOCKOUT_SECONDS = 5 * 60;

// ---- Shapes ---------------------------------------------------------------

const NO_SEAL = {
    enabled: false,
    hint: "",
    recovery: null
};

function unsealedState() {
    return Object.assign({}, NO_SEAL);
}

const DEFAULT_SEAL_ATTEMPTS = {
    failures: 0,
    lockedUntil: 0
};

// A seal missing its salt or verifier can't verify anything, so it is treated
// as no seal at all rather than as an unopenable lock. Storage is storage.
function normalizeSeal(raw) {
    const source = raw || {};

    if (source.enabled !== true || !source.salt || !source.verifier) {
        return unsealedState();
    }

    return {
        enabled: true,
        algorithm: SEAL_ALGORITHM,
        iterations: Math.max(1, Math.round(Number(source.iterations) || SEAL_ITERATIONS)),
        salt: String(source.salt),
        verifier: String(source.verifier),
        hint: String(source.hint || "").slice(0, MAX_SEAL_HINT_LENGTH),
        recovery: source.recovery && source.recovery.requestedAt
            ? { requestedAt: Number(source.recovery.requestedAt) }
            : null
    };
}

function normalizeSealAttempts(raw) {
    const source = raw || {};

    return {
        failures: Math.max(0, Math.round(Number(source.failures) || 0)),
        lockedUntil: Math.max(0, Number(source.lockedUntil) || 0)
    };
}

// ---- Hashing --------------------------------------------------------------

// Uint8Array <-> base64. Storage is JSON, and a base64 string survives the
// round trip intact where a typed array would come back as a plain object.

function toBase64(bytes) {
    let binary = "";
    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary);
}

function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function randomSalt() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return toBase64(bytes);
}

// PBKDF2-SHA256. crypto.subtle is available on chrome-extension:// pages,
// which are secure contexts — the same WebCrypto that Tasks.js already uses
// for randomInt().
function deriveVerifier(password, saltB64, iterations) {
    const encoder = new TextEncoder();

    return crypto.subtle
        .importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"])
        .then((key) => crypto.subtle.deriveBits({
            name: "PBKDF2",
            salt: fromBase64(saltB64),
            iterations: iterations,
            hash: "SHA-256"
        }, key, 256))
        .then((bits) => toBase64(new Uint8Array(bits)));
}

// Plain string comparison, deliberately. A constant-time compare defends
// against an attacker timing the response over a network; here the "attacker"
// owns the machine, the page and the debugger, and could read the verifier
// directly. Hashing is worth doing because it protects a REUSED password.
// Timing hardening on top of it would be cargo cult.
function verifiersMatch(a, b) {
    return a === b;
}

// ---- Reading --------------------------------------------------------------

// The single entry point for reading the seal, the way loadCategories() is for
// the category model. It also resolves an elapsed recovery, so no caller has
// to know that a seal can expire.
function loadSeal() {
    return new Promise((resolve) => {
        chrome.storage.local.get([SEAL_KEY], (result) => {
            const seal = normalizeSeal(result[SEAL_KEY]);

            // Recovery is resolved lazily on read rather than by a timer, the
            // same way Background.js handles an expired tempUnlock. That is
            // what keeps this feature from needing the alarms permission.
            if (seal.enabled && seal.recovery && recoveryRemainingMs(seal) <= 0) {
                chrome.storage.local.set({
                    [SEAL_KEY]: unsealedState(),
                    [SEAL_ATTEMPTS_KEY]: Object.assign({}, DEFAULT_SEAL_ATTEMPTS)
                }, () => resolve(unsealedState()));
                return;
            }

            resolve(seal);
        });
    });
}

function isSealed() {
    return loadSeal().then((seal) => seal.enabled);
}

function loadSealAttempts() {
    return new Promise((resolve) => {
        chrome.storage.local.get([SEAL_ATTEMPTS_KEY], (result) => {
            resolve(normalizeSealAttempts(result[SEAL_ATTEMPTS_KEY]));
        });
    });
}

function writeSealAttempts(attempts) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [SEAL_ATTEMPTS_KEY]: attempts }, () => resolve(attempts));
    });
}

// ---- Throttling -----------------------------------------------------------

// How long the next attempt has to wait, given how many have already failed.
// Mirrors effectiveCooldownSeconds() in shape but not in constants: that one
// runs through normalizeCooldown(), whose floor is a full minute, and a
// sixty-second penalty for one mistyped character is punishment rather than
// friction.
function effectiveLockoutSeconds(failures) {
    if (!failures || failures <= SEAL_FREE_ATTEMPTS) return 0;

    const steps = failures - SEAL_FREE_ATTEMPTS - 1;
    const seconds = SEAL_LOCKOUT_BASE_SECONDS * Math.pow(SEAL_LOCKOUT_FACTOR, steps);

    return Math.min(MAX_SEAL_LOCKOUT_SECONDS, Math.round(seconds));
}

// Seconds still to wait before another attempt is allowed. Derived from a
// stored timestamp rather than a running countdown, so closing the popup
// mid-wait doesn't clear it.
function lockoutRemaining(attempts) {
    return Math.max(0, Math.ceil((attempts.lockedUntil - Date.now()) / 1000));
}

function sealLockoutRemaining() {
    return loadSealAttempts().then(lockoutRemaining);
}

function recordSealFailure() {
    return loadSealAttempts().then((attempts) => {
        const failures = attempts.failures + 1;

        return writeSealAttempts({
            failures: failures,
            lockedUntil: Date.now() + effectiveLockoutSeconds(failures) * 1000
        });
    });
}

function clearSealFailures() {
    return writeSealAttempts(Object.assign({}, DEFAULT_SEAL_ATTEMPTS));
}

// ---- Verifying ------------------------------------------------------------

// Resolves { ok, waitSeconds }. An unsealed fortress always says yes, so
// callers can ask without checking whether a seal exists first.
function verifySeal(password) {
    return Promise.all([loadSeal(), loadSealAttempts()]).then(([seal, attempts]) => {
        if (!seal.enabled) return { ok: true, waitSeconds: 0 };

        const waiting = lockoutRemaining(attempts);
        if (waiting > 0) return { ok: false, waitSeconds: waiting };

        return deriveVerifier(password, seal.salt, seal.iterations).then((verifier) => {
            if (verifiersMatch(verifier, seal.verifier)) {
                return clearSealFailures().then(() => ({ ok: true, waitSeconds: 0 }));
            }

            return recordSealFailure().then((next) => ({
                ok: false,
                waitSeconds: lockoutRemaining(next)
            }));
        });
    });
}

// ---- Setting, changing, breaking ------------------------------------------

// Resolves an error string, or null when the password is usable. Returning the
// message rather than a boolean keeps the wording in one place instead of at
// every call site.
function validateSealPassword(password, hint) {
    const value = String(password || "");

    if (value.length < SEAL_MIN_LENGTH) {
        return `Your seal must be at least ${SEAL_MIN_LENGTH} characters.`;
    }

    // A hint that is the password is not a hint, it is the password written on
    // the door — and it would be shown on the prompt to anyone who opened it.
    if (hint && String(hint).trim() === value) {
        return "Your hint can't be your seal.";
    }

    return null;
}

// Sets a seal on an unsealed fortress. Resolves { ok } or { ok:false, error }.
function setSeal(password, hint) {
    const problem = validateSealPassword(password, hint);
    if (problem) return Promise.resolve({ ok: false, error: problem });

    const salt = randomSalt();

    return deriveVerifier(password, salt, SEAL_ITERATIONS).then((verifier) => {
        const seal = {
            enabled: true,
            algorithm: SEAL_ALGORITHM,
            iterations: SEAL_ITERATIONS,
            salt: salt,
            verifier: verifier,
            hint: String(hint || "").trim().slice(0, MAX_SEAL_HINT_LENGTH),
            recovery: null
        };

        return new Promise((resolve) => {
            chrome.storage.local.set({
                [SEAL_KEY]: seal,
                [SEAL_ATTEMPTS_KEY]: Object.assign({}, DEFAULT_SEAL_ATTEMPTS)
            }, () => resolve({ ok: true }));
        });
    });
}

// Replacing a seal needs the current one. Without that check, "change seal"
// would be a way around the prompt for anyone sitting at an unlocked machine.
function changeSeal(currentPassword, nextPassword, hint) {
    const problem = validateSealPassword(nextPassword, hint);
    if (problem) return Promise.resolve({ ok: false, error: problem });

    return verifySeal(currentPassword).then((result) => {
        if (!result.ok) return sealFailure(result);
        return setSeal(nextPassword, hint);
    });
}

// Breaking the seal is itself a weakening, so it costs the seal.
function clearSeal(password) {
    return verifySeal(password).then((result) => {
        if (!result.ok) return sealFailure(result);

        return new Promise((resolve) => {
            chrome.storage.local.set({
                [SEAL_KEY]: unsealedState(),
                [SEAL_ATTEMPTS_KEY]: Object.assign({}, DEFAULT_SEAL_ATTEMPTS)
            }, () => resolve({ ok: true }));
        });
    });
}

// Shared wording for a rejected password, so the wait is always explained
// rather than the button just doing nothing.
function sealFailure(result) {
    return {
        ok: false,
        error: result.waitSeconds > 0
            ? `That isn't your seal. Wait ${formatHuman(result.waitSeconds)} before trying again.`
            : "That isn't your seal."
    };
}

// ---- Recovery -------------------------------------------------------------

function recoveryRemainingMs(seal) {
    if (!seal || !seal.enabled || !seal.recovery) return 0;
    return Math.max(0, (seal.recovery.requestedAt + SEAL_RECOVERY_MS) - Date.now());
}

// Starts the hour. Deliberately does nothing if one is already running, so
// clicking twice can't reset the clock the user is waiting out.
function requestSealRecovery() {
    return loadSeal().then((seal) => {
        if (!seal.enabled || seal.recovery) return seal;

        const updated = Object.assign({}, seal, {
            recovery: { requestedAt: Date.now() }
        });

        return new Promise((resolve) => {
            chrome.storage.local.set({ [SEAL_KEY]: updated }, () => resolve(updated));
        });
    });
}

// Free and instant, on purpose. A recovery you started and thought better of
// should cost nothing to call off, or nobody will risk starting one.
function cancelSealRecovery() {
    return loadSeal().then((seal) => {
        if (!seal.enabled || !seal.recovery) return seal;

        const updated = Object.assign({}, seal, { recovery: null });

        return new Promise((resolve) => {
            chrome.storage.local.set({ [SEAL_KEY]: updated }, () => resolve(updated));
        });
    });
}

// "43 min" / "1 hour" for the pending-recovery notices. Coarser than
// formatHuman() because a countdown to the second would invite watching it.
function formatRecoveryRemaining(ms) {
    const minutes = Math.ceil(ms / 60000);
    if (minutes >= 60) return "1 hour";
    if (minutes <= 1) return "under a minute";
    return `${minutes} min`;
}

// ---- What counts as weakening ---------------------------------------------
//
// describeWeakening() compares two fortress states and returns a line for each
// way the second is weaker than the first. The lines are not diagnostics: they
// are the body of the prompt. Naming what is being given up before asking for
// the password is the same thing every gate since 1.4.5 has done, and it is
// what stops the seal feeling like an obstacle rather than a reminder.
//
// A state is { categories, manualSites, task, cooldown }.

function countSites(n) {
    return `${n} ${n === 1 ? "site" : "sites"}`;
}

// Kept as one phrase rather than countSites() plus a fixed verb, so the verb
// agrees: "1 site stops", "3 sites stop".
function sitesStopBeingBlocked(n) {
    return n === 1
        ? "1 site stops being blocked"
        : `${n} sites stop being blocked`;
}

// "Gaming's" for a category, "Fortress-wide" for the defaults everything else
// inherits.
function standardsOwner(categoryName) {
    return categoryName ? `${categoryName}'s` : "Fortress-wide";
}

// Lines for a task that got weaker. Adding one, or editing the words of a
// reflection message, is not weakening and produces nothing.
function describeTaskChange(before, after, categoryName, lines) {
    const owner = standardsOwner(categoryName);

    if (!before) return;

    if (!after) {
        lines.push(`${owner} ${getTaskTitle(before.type)} task removed.`);
        return;
    }

    // Swapping a task for a different one is counted, because "is a passage
    // weaker than a code" has no honest answer and leaving it uncounted makes
    // the swap a way around the seal: a Guarded Code you have to walk across
    // the house for could become a four-word message you type on the spot.
    // The line says "changed" rather than "weakened", which is true either way
    // and lets the user judge it.
    if (before.type !== after.type) {
        lines.push(
            `${owner} task changed from ${getTaskTitle(before.type)} to ${getTaskTitle(after.type)}.`
        );
        return;
    }

    // Regenerating a Guarded Code kills the copy the user wrote down and puts
    // a fresh one on screen in front of them — which is exactly the walk the
    // task exists to make them take.
    if (before.type === "code" && before.code && after.code && before.code !== after.code) {
        lines.push(
            `${owner} Guarded Code replaced — the code you wrote down stops working.`
        );
    }
}

function describeCooldownChange(before, after, categoryName, lines) {
    const owner = standardsOwner(categoryName);
    const was = normalizeCooldown(before);
    const now = normalizeCooldown(after);

    if (now.seconds < was.seconds) {
        lines.push(
            `${owner} cooldown shortened from ${formatHuman(was.seconds)} to ${formatHuman(now.seconds)}.`
        );
    }

    if (was.escalate && !now.escalate) {
        lines.push(`${owner} escalation switched off.`);
    } else if (was.escalate && now.escalate && now.factor < was.factor) {
        lines.push(`${owner} escalation rate lowered from ${was.factor}× to ${now.factor}×.`);
    }
}

// The task that actually applies to a category's sites: its own override if it
// declared one, otherwise the fortress-wide task. Same inheritance rule as
// resolveTaskForDomain(), so dropping an override that merely repeated the
// fortress default correctly reads as no change at all.
function effectiveCategoryTask(category, fortressTask) {
    return ("task" in category) ? category.task : (fortressTask || null);
}

function effectiveCategoryCooldown(category, fortressCooldown) {
    return category.cooldown ? category.cooldown : fortressCooldown;
}

function describeCategoryStandards(was, now, before, after, lines) {
    // When neither side declares an override, these sites are governed by the
    // fortress-wide standards — whose changes are reported once, below, rather
    // than repeated for every category that inherits them.
    const hadOwnTask = "task" in was;
    const hasOwnTask = "task" in now;

    if (hadOwnTask || hasOwnTask) {
        describeTaskChange(
            effectiveCategoryTask(was, before.task),
            effectiveCategoryTask(now, after.task),
            now.name,
            lines
        );
    }

    if (was.cooldown || now.cooldown) {
        describeCooldownChange(
            effectiveCategoryCooldown(was, before.cooldown),
            effectiveCategoryCooldown(now, after.cooldown),
            now.name,
            lines
        );
    }
}

function describeWeakening(before, after) {
    const lines = [];

    const beforeCategories = before.categories || [];
    const afterCategories = after.categories || [];
    const afterById = new Map(afterCategories.map((category) => [category.id, category]));

    beforeCategories.forEach((was) => {
        const now = afterById.get(was.id);

        // A category that wasn't switched on wasn't defending anything, so
        // deleting or emptying it takes nothing down with it. Same reasoning
        // requestCategoryDelete() already uses to decide whether to open its
        // gate at all.
        if (!was.enabled) return;

        if (!now) {
            if (was.sites.length) {
                lines.push(`${was.name} deleted — ${sitesStopBeingBlocked(was.sites.length)}.`);
            }
            return;
        }

        if (!now.enabled) {
            lines.push(`${was.name} switched off — ${sitesStopBeingBlocked(was.sites.length)}.`);
            // Everything else about a category that is now off is moot: its
            // sites aren't blocked either way, and listing further changes to
            // it would pad the prompt with things that don't matter.
            return;
        }

        const dropped = was.sites.filter((site) => !now.sites.includes(site));
        if (dropped.length === 1) {
            lines.push(`${dropped[0]} removed from ${now.name}.`);
        } else if (dropped.length > 1) {
            lines.push(`${countSites(dropped.length)} removed from ${now.name}.`);
        }

        // Permanence resolves most-restrictive when a site sits in several
        // categories (isPermanentDomain), so lifting it anywhere is a real
        // loosening even if another category still seals the same site.
        if (was.permanent && !now.permanent) {
            lines.push(`Permanent block lifted on ${now.name}.`);
        }

        describeCategoryStandards(was, now, before, after, lines);
    });

    const afterManual = after.manualSites || [];
    const droppedManual = (before.manualSites || [])
        .filter((site) => !afterManual.includes(site));

    if (droppedManual.length === 1) {
        lines.push(`${droppedManual[0]} unblocked.`);
    } else if (droppedManual.length > 1) {
        lines.push(`${countSites(droppedManual.length)} unblocked.`);
    }

    describeTaskChange(before.task, after.task, null, lines);
    describeCooldownChange(before.cooldown, after.cooldown, null, lines);

    return lines;
}

// ---- The chokepoint -------------------------------------------------------
//
// Every edit to the fortress goes through commitFortress(). Before 1.9 three
// separate handlers wrote these keys directly, which meant the rule at the top
// of this file existed only as an agreement between them — and each one had to
// remember to re-derive blockedSites on its way past. Routing them through one
// function makes the rule a thing that exists, and gives Scheduling and Sync
// somewhere to arrive.
//
// The one write that deliberately does NOT come through here is the migration
// inside loadCategories(): it rewrites the stored shape on first read, which
// is not a user edit, and charging the seal for it would prompt every fortress
// upgrading from 1.8 before its owner had touched anything.

function loadStandards() {
    return new Promise((resolve) => {
        chrome.storage.local.get(["unlockTask", "cooldownSettings"], (result) => {
            resolve({
                task: result.unlockTask || null,
                cooldown: normalizeCooldown(result.cooldownSettings)
            });
        });
    });
}

// The whole fortress as one object, which is the unit describeWeakening()
// compares and writeFortress() persists.
function readFortress() {
    return Promise.all([loadCategories(), loadStandards()]).then(([model, standards]) => ({
        categories: model.categories,
        manualSites: model.manualSites,
        task: standards.task,
        cooldown: standards.cooldown
    }));
}

// Fills in whatever the caller left out from what is already stored.
//
// A caller can legitimately not know about parts of the fortress — the popup
// has no idea what the unlock task is — so an absent key has to mean "leave
// this alone" rather than "clear it". `task` is checked with `in` because null
// is a real value there: it means "deliberately no task", the same
// undefined-vs-null convention readTaskPicker() uses.
function fillFortressState(next, stored) {
    return {
        categories: next.categories || stored.categories,
        manualSites: next.manualSites || stored.manualSites,
        task: ("task" in next) ? next.task : stored.task,
        cooldown: next.cooldown || stored.cooldown
    };
}

// Resolves { saved:true, blockedSites, state }.
function writeFortress(state) {
    // blockedSites is derived here rather than by the caller, and that is half
    // the reason this function exists: it is what Background.js reads on every
    // navigation, and a page that edited the categories but forgot to re-derive
    // it would leave what is enforced disagreeing with what is shown.
    const blockedSites = computeBlockedSites(state.categories, state.manualSites);

    return new Promise((resolve) => {
        chrome.storage.local.set({
            [CATEGORY_DEFS_KEY]: state.categories,
            [MANUAL_SITES_KEY]: state.manualSites,
            blockedSites: blockedSites,
            unlockTask: state.task,
            cooldownSettings: normalizeCooldown(state.cooldown)
        }, () => resolve({ saved: true, blockedSites: blockedSites, state: state }));
    });
}

// Commits a fortress edit, charging the seal if the edit takes defences down.
//
// Resolves { saved:true, blockedSites, state } or { saved:false, reason }. A
// refused commit writes nothing at all — callers must leave their working copy
// exactly as it was, so the user's edits are still on screen to retry or undo.
function commitFortress(next) {
    return readFortress().then((before) => {
        const after = fillFortressState(next, before);
        const weakenings = describeWeakening(before, after);

        // Strengthening the fortress is free. This is the branch that makes it
        // true, and it is the common one: blocking a site, adding a category,
        // lengthening a cooldown.
        if (!weakenings.length) return writeFortress(after);

        return isSealed().then((sealed) => {
            if (!sealed) return writeFortress(after);

            return promptForSeal(weakenings).then((granted) => granted
                ? writeFortress(after)
                : { saved: false, reason: "refused" });
        });
    });
}

// ---- The prompt -----------------------------------------------------------
//
// Built here rather than written into each page's HTML, the way
// renderCooldownBlock() is: the popup and the fortress page both raise it, and
// two copies of the markup would be two things to keep in step. It renders
// into the shared .modal-overlay / .modal-box classes that live in Common.css.
//
// Everything is built as nodes rather than innerHTML. The lines it displays
// contain category names the user typed, which have no business being parsed
// as markup — the same reason renderGoverningCategory() builds its badge by
// hand on the blocked page.

function sealElement(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

// Resolves true if the seal was given, false if the user backed out or started
// a recovery. False must leave the fortress exactly as it was.
function promptForSeal(weakenings) {
    return Promise.all([loadSeal(), sealLockoutRemaining()])
        .then(([seal, waiting]) => new Promise((resolve) => {
            buildSealPrompt(seal, waiting, weakenings, resolve);
        }));
}

function buildSealPrompt(seal, waiting, weakenings, resolve) {
    const overlay = sealElement("div", "modal-overlay seal-overlay");
    const box = sealElement("div", "modal-box");
    overlay.appendChild(box);

    box.appendChild(sealElement("h2", "modal-title", "THE SEAL"));

    // The streak at stake, filled in when it resolves. Same line the removal
    // gates have shown since 1.4.5 — the seal replaces those gates when it is
    // set, so it has to carry what they carried.
    const streak = sealElement("p", "modal-streak", "");
    box.appendChild(streak);
    getStats().then((stats) => {
        if (!overlay.isConnected || stats.currentStreak <= 0) return;
        const days = stats.currentStreak;
        streak.textContent =
            `You're on a ${days}-day discipline streak — don't dismantle what you've built.`;
    });

    box.appendChild(sealElement("p", "modal-text", "This takes defences down:"));

    const losses = sealElement("ul", "seal-losses");
    weakenings.forEach((line) => losses.appendChild(sealElement("li", null, line)));
    box.appendChild(losses);

    const input = sealElement("input", "seal-input");
    input.type = "password";
    input.placeholder = "Your seal";
    input.setAttribute("aria-label", "Your seal");
    // Pasting is deliberately NOT blocked here, unlike the typing tasks: the
    // target text is not on screen, and a password manager filling this in is
    // someone using their own seal, not shortcutting a challenge.
    box.appendChild(input);

    if (seal.hint) {
        box.appendChild(sealElement("p", "seal-hint", `Hint: ${seal.hint}`));
    }

    const error = sealElement("p", "seal-error", "");
    box.appendChild(error);

    const actions = sealElement("div", "modal-actions");
    const cancel = sealElement("button", "modal-btn modal-btn-secondary", "CANCEL");
    const confirm = sealElement("button", "modal-btn", "UNSEAL");
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    box.appendChild(actions);

    const forgot = sealElement("button", "seal-forgot", "Forgot your seal?");
    box.appendChild(forgot);

    // ---- wiring ----------------------------------------------------------

    let countdown = null;

    function finish(granted) {
        clearInterval(countdown);
        overlay.remove();
        resolve(granted);
    }

    // Locks the input for the rest of a wait the throttle has imposed, ticking
    // down so the user can see it is finite rather than the button being dead.
    function holdFor(seconds) {
        clearInterval(countdown);

        let remaining = seconds;
        input.disabled = true;
        confirm.disabled = true;
        confirm.classList.add("disabled");

        function tick() {
            if (remaining <= 0) {
                clearInterval(countdown);
                input.disabled = false;
                confirm.disabled = false;
                confirm.classList.remove("disabled");
                confirm.textContent = "UNSEAL";
                input.focus();
                return;
            }
            confirm.textContent = `UNSEAL (${remaining})`;
            remaining--;
        }

        tick();
        countdown = setInterval(tick, 1000);
    }

    function attempt() {
        if (confirm.disabled) return;

        const password = input.value;
        input.value = "";

        verifySeal(password).then((result) => {
            if (!overlay.isConnected) return;

            if (result.ok) return finish(true);

            error.textContent = result.waitSeconds > 0
                ? `That isn't your seal. Wait ${formatHuman(result.waitSeconds)} before trying again.`
                : "That isn't your seal.";

            if (result.waitSeconds > 0) holdFor(result.waitSeconds);
        });
    }

    confirm.addEventListener("click", attempt);
    cancel.addEventListener("click", () => finish(false));

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") attempt();
    });

    overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") finish(false);
    });

    forgot.addEventListener("click", () => {
        renderRecoveryOffer(box, finish, seal);
    });

    document.body.appendChild(overlay);

    if (waiting > 0) {
        error.textContent = `Wait ${formatHuman(waiting)} before trying again.`;
        holdFor(waiting);
    } else {
        input.focus();
    }
}

// The forgot-your-seal path. It replaces the prompt's contents rather than
// opening a second dialog, so there is only ever one thing on screen — and it
// states the cost plainly instead of asking "are you sure?", which nobody
// reads.
function renderRecoveryOffer(box, finish, seal) {
    box.textContent = "";

    box.appendChild(sealElement("h2", "modal-title", "LIFT THE SEAL?"));
    box.appendChild(sealElement("p", "modal-text",
        "The seal will lift in 1 hour. Your fortress stands untouched until then, "
        + "and you can call this off at any point before it does."));

    if (seal.hint) {
        box.appendChild(sealElement("p", "seal-hint", `Your hint: ${seal.hint}`));
    }

    const actions = sealElement("div", "modal-actions");
    const back = sealElement("button", "modal-btn modal-btn-secondary", "NEVER MIND");
    const start = sealElement("button", "modal-btn", "START THE HOUR");
    actions.appendChild(back);
    actions.appendChild(start);
    box.appendChild(actions);

    back.addEventListener("click", () => finish(false));

    start.addEventListener("click", () => {
        requestSealRecovery().then(() => {
            // Refused, not granted: the seal is still on for the next hour, so
            // this edit does not go through. That is the point — recovery is a
            // way back into your settings tomorrow, not a way past the prompt
            // tonight.
            finish(false);
        });
    });
}
