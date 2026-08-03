// Tasks.js — shared definitions for unlock tasks and the cooldown.
//
// Loaded by BOTH Build Fortress (where a task is configured) and the blocked
// page (where it is enforced), so the two can never disagree about what a task
// is called, what its limits are, or how long a cooldown actually lasts.
//
// Dependency-free classic script: everything is declared at the top level and
// lives on the global scope. It touches no storage and no DOM, so it is safe to
// load from any page in either order.
//
// Design note — the cooldown is NOT part of the task:
// Every task ends in the same countdown, and the countdown also runs when no
// task is configured at all. So it is stored under its own `cooldownSettings`
// key rather than nested inside `unlockTask`. A task only contributes a
// *suggested* default that pre-fills the form; once saved, the two are
// independent.

// ---- Limits ---------------------------------------------------------------

// Floors the user cannot go below. The whole point of the feature is friction,
// so a 5-second cooldown or a 1.01x escalation would be self-defeating.
const MIN_COOLDOWN_SECONDS = 60;
const MIN_ESCALATION_FACTOR = 1.25;

// Ceiling on the *escalated* cooldown. Without it, 1.25^n compounds fast —
// 30 unlocks of one site in a day would demand a 13-hour wait, which stops
// being friction and becomes an accidental permanent block.
const MAX_COOLDOWN_SECONDS = 60 * 60; // 1 hour

// How long a "you are about to dismantle your own defences" confirmation stays
// locked before it can be clicked. Shared by the popup's block-removal gate and
// the fortress page's task-removal gate, so a future normal/hard strictness
// setting only has one dial to turn.
//
// This is deliberately short. Dominus can be uninstalled in ten seconds by
// anyone who wants out, so none of this is a lock — it is a pause, aimed at the
// impulse rather than the decision. Someone who genuinely wants the block gone
// should be able to remove it; they just shouldn't be able to do it without
// noticing they did.
const REMOVE_COOLDOWN_SECONDS = 10;

// ---- Task catalog ---------------------------------------------------------

// The single source of truth for the task dropdown. `id` is what gets persisted
// as unlockTask.type, so these strings are a storage contract — renaming one
// orphans every task already saved under the old id.
//
// "cooldown" is the original (and only) task type from before the picker
// existed, kept under its old id so tasks saved by earlier versions still load.
const TASK_TYPES = [
    {
        id: "cooldown",
        title: "Reflection Message",
        tooltip: "You write a message to yourself now, while you are thinking clearly. To unlock later, you have to type it back word for word. Pasting is disabled.",
        defaultCooldownSeconds: 60
    },
    {
        id: "passage",
        title: "Random Passage",
        tooltip: "The blocked page generates a fresh line of random words and you must type it exactly. There is no shortcut and nothing to memorise — the effort is the point. Pasting is disabled.",
        defaultCooldownSeconds: 60
    },
    {
        id: "code",
        title: "Guarded Code",
        tooltip: "A code is generated once, now. Write it down and leave it somewhere inconvenient — another room, a drawer, a friend. Unlocking means physically going to get it.",
        defaultCooldownSeconds: 60
    }
];

function getTaskType(id) {
    return TASK_TYPES.find((task) => task.id === id) || null;
}

function getTaskTitle(id) {
    const task = getTaskType(id);
    return task ? task.title : "Unknown task";
}

// ---- Cooldown settings ----------------------------------------------------

const DEFAULT_COOLDOWN = {
    seconds: MIN_COOLDOWN_SECONDS,
    escalate: false,
    factor: MIN_ESCALATION_FACTOR
};

// Clamps whatever came out of storage (or off a form) into a usable shape.
// Number(...) || fallback also catches NaN, which is what an empty or
// non-numeric input field parses to.
function normalizeCooldown(raw) {
    const source = raw || {};

    const seconds = Math.max(
        MIN_COOLDOWN_SECONDS,
        Math.round(Number(source.seconds) || DEFAULT_COOLDOWN.seconds)
    );

    const factor = Math.max(
        MIN_ESCALATION_FACTOR,
        Number(source.factor) || DEFAULT_COOLDOWN.factor
    );

    return {
        seconds: seconds,
        escalate: source.escalate === true,
        factor: factor
    };
}

// How long the countdown actually runs, given how many times this specific site
// has already been unlocked today. `priorUnlocks` of 0 is the first unlock of
// the day and gets the base duration untouched.
function effectiveCooldownSeconds(cooldown, priorUnlocks) {
    const settings = normalizeCooldown(cooldown);

    if (!settings.escalate || !priorUnlocks || priorUnlocks < 1) {
        return settings.seconds;
    }

    const escalated = settings.seconds * Math.pow(settings.factor, priorUnlocks);
    return Math.min(MAX_COOLDOWN_SECONDS, Math.round(escalated));
}

// ---- Formatting -----------------------------------------------------------

// "M:SS" for the live countdown.
function formatClock(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Readable duration for labels and warnings ("3 minutes", "2 min 30 sec").
function formatHuman(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (seconds === 0) {
        return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    }
    if (minutes === 0) {
        return `${seconds} sec`;
    }
    return `${minutes} min ${seconds} sec`;
}

// ---- Generators -----------------------------------------------------------

// Plain, unambiguous, easy-to-spell words. The difficulty should come from the
// length of the typing, not from guessing how a word is spelled.
const PASSAGE_WORDS = [
    "anchor", "border", "candle", "harbor", "lantern", "meadow", "pillar",
    "ribbon", "saddle", "timber", "velvet", "wander", "basket", "copper",
    "dagger", "ember", "forest", "gravel", "hollow", "iron", "kettle",
    "ladder", "marble", "needle", "orchard", "pebble", "quarry", "river",
    "silver", "thunder", "valley", "willow", "amber", "bridge", "cinder",
    "drifting", "echo", "furnace", "garden", "hammer", "island", "journey",
    "keeper", "linen", "mantle", "north", "oaken", "prairie", "quiet",
    "rampart", "stone", "tunnel", "unbroken", "vessel", "winter", "yonder"
];

const PASSAGE_WORD_COUNT = 12;

// crypto.getRandomValues (not Math.random) purely for a flat distribution —
// there is nothing to attack here, the user owns the machine either way.
function randomInt(maxExclusive) {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] % maxExclusive;
}

// A fresh line of random words, generated per unlock attempt so there is
// nothing to memorise between attempts.
function generatePassage() {
    const words = [];
    for (let i = 0; i < PASSAGE_WORD_COUNT; i++) {
        words.push(PASSAGE_WORDS[randomInt(PASSAGE_WORDS.length)]);
    }
    return words.join(" ");
}

// Ambiguous glyphs (0/O, 1/I/L) are excluded so a code copied onto paper can be
// read back without guesswork.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function generateGuardCode() {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

// ---- Output escaping ------------------------------------------------------

// Escapes text before it reaches innerHTML. Both pages render user-authored
// content (the reflection message) into template literals, where a stray "<"
// would otherwise be parsed as markup.
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ---- Input hardening ------------------------------------------------------

// Blocks paste/drop/autofill on a typing challenge. Without this, every typing
// task collapses into two keystrokes: the target text is on screen, so Ctrl+C /
// Ctrl+V defeats it outright.
function blockPasteOn(inputEl) {
    if (!inputEl) return;

    ["paste", "drop"].forEach((eventName) => {
        inputEl.addEventListener(eventName, (event) => {
            event.preventDefault();
        });
    });

    inputEl.setAttribute("autocomplete", "off");
    inputEl.setAttribute("autocorrect", "off");
    inputEl.setAttribute("spellcheck", "false");
}
