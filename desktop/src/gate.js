// gate.js — what a blocked program gets you.
//
// The same gate the browser raises, in a window, because the browser cannot see
// a process. The rules are not reimplemented here: the task types, the cooldown
// arithmetic, the escalation count and the event log all come from the shared
// layer copied in beside this file. What is local is the wiring and the words.
//
// Two things this window is responsible for and Rust is not:
//
//   - Recording. Rust raises the gate and is told when it closes, and is never
//     told which way it went. A stand and an unlock are events in the log, and
//     the log is written here, through the same functions the extension uses.
//
//   - Deciding what happens next. Rust holds a list of executables and a map of
//     expiries and nothing else. When an unlock is granted, this window is what
//     tells it the new expiry.
//
// See ../APP-LIMITS.md, "The gate".

const heading = document.getElementById("gateHeading");
const programEl = document.getElementById("gateProgram");
const lineEl = document.getElementById("gateLine");
const taskArea = document.getElementById("gateTask");
const actions = document.getElementById("gateActions");
const noteEl = document.getElementById("gateNote");
const walkBtn = document.getElementById("gateWalk");
const unlockBtn = document.getElementById("gateUnlock");

// What is currently being stood in front of. Replaced whenever Rust raises the
// gate again, which it only does after this window has said the last one closed.
let pending = null;
let peer = { stateRev: 0, state: null, device: "" };

// Guards a double answer. The countdown ends, the user clicks, and a stray
// second click must not record two unlocks for one decision.
let answered = false;

function hasBridge() {
    return Boolean(window.__TAURI__ && window.__TAURI__.core);
}

const native = {
    async pendingGate() {
        if (!hasBridge()) return null;
        try {
            return await window.__TAURI__.core.invoke("pending_gate");
        } catch (error) {
            return null;
        }
    },

    async peerState() {
        if (!hasBridge()) return { stateRev: 0, state: null, device: "" };
        try {
            return await window.__TAURI__.core.invoke("peer_state");
        } catch (error) {
            return { stateRev: 0, state: null, device: "" };
        }
    },

    async putState(expectedRev, next) {
        if (!hasBridge()) return null;
        try {
            return await window.__TAURI__.core.invoke("put_state", {
                expectedRev: expectedRev,
                next: next
            });
        } catch (error) {
            return null;
        }
    },

    async closeProgram(exe) {
        if (!hasBridge() || !exe) return 0;
        try {
            return await window.__TAURI__.core.invoke("close_application", { exe: exe });
        } catch (error) {
            // A program that cannot be asked is a program that stays open and
            // stays gated, which is where this started. Nothing escalates.
            return 0;
        }
    },

    async setEnforced(enforced) {
        if (!hasBridge()) return;
        try {
            await window.__TAURI__.core.invoke("set_enforced", { enforced: enforced });
        } catch (error) {
            // Nothing to do about it here. The next state change pushes again,
            // and until then Rust is enforcing the previous list — which is
            // stricter than the new one, never weaker.
        }
    },

    // Rust is told the gate is closed and hides the window. It is deliberately
    // not told whether the user stood or unlocked: recording is this window's
    // job, and a second place that knows is a second place that can disagree.
    async closeGate() {
        if (!hasBridge()) return;
        try {
            await window.__TAURI__.core.invoke("close_gate");
        } catch (error) {
            /* the window stays up; the user can still answer it */
        }
    }
};

// ---- What we are standing in front of -------------------------------------

function applicationFor(exe) {
    const fortress = (peer.state && peer.state.fortress) || {};
    return findApplication(fortress.applications, exe);
}

// Why the gate is up, in one line. A program with an allowance was not blocked
// by the user so much as given so long — and saying "you blocked this" when
// they had an hour and used it would be telling them something untrue.
function gateReason(exe) {
    const application = applicationFor(exe);
    const entry = application ? normalizeApplication(application) : null;
    const minutes = entry ? entry.allowanceMinutes : 0;
    return minutes > 0
        ? `You've used today's ${formatAllowance(minutes)}. Dominus has put it away.`
        : "You blocked this. Dominus has put it away.";
}

function displayName(exe) {
    const application = applicationFor(exe);
    return (application && application.name) || applicationDisplayName(exe) || exe;
}

// Resolves once open() has the fortress in hand. A button pressed in the moment
// between the window appearing and the state arriving waits for it, rather than
// answering with no state at all — which recorded nothing and still closed the
// gate, so a walk-away could vanish without trace.
let opening = Promise.resolve();

// Called by every button before it does anything. If the gate is showing but
// was never told what for, it asks now instead of answering blind.
async function ready() {
    await opening;
    if (!pending) await syncWithNative();
    await opening;
    return Boolean(pending && peer.state);
}

function open(next) {
    opening = load(next);
    return opening;
}

async function load(next) {
    pending = next;
    answered = false;
    peer = await native.peerState();

    const exe = (pending && pending.exe) || "";

    programEl.textContent = displayName(exe);
    heading.textContent = "HALT.";
    lineEl.textContent = gateReason(exe);
    taskArea.innerHTML = "";
    noteEl.textContent = "";
    actions.hidden = false;
    labelWalkAway(walkBtn, exe);
    walkBtn.disabled = false;
    unlockBtn.disabled = false;
}

// ---- Walking away ---------------------------------------------------------

// Labels a walk-away button with what it actually does, naming the program.
//
// "WALK AWAY" on its own reads as "leave it where it is" — and where it is, is
// minimized, which is the one state the user cannot get out of. Clicking it in
// the taskbar minimizes it again; the way out is to hover the taskbar and close
// it from the preview, which is escapable only if you already know. So the
// button says it closes the program, and closing the program is what it now
// does.
function labelWalkAway(button, exe) {
    const name = displayName(exe);

    button.textContent = "";
    const line = document.createElement("span");
    line.className = "btn-line";
    line.textContent = "WALK AWAY";
    const sub = document.createElement("span");
    sub.className = "btn-sub";
    // Built as nodes, not markup: the name is the one the user typed.
    sub.textContent = "and close " + name;
    button.append(line, sub);

    button.title = "Records a stand and asks " + name + " to close. It is a request,"
        + " not a kill — anything unsaved still prompts you, and a program that"
        + " refuses stays open and stays gated.";
}

// Every walk-away button: the one in the markup and the ones the task and
// countdown views build for themselves. All three are the same decision.
function wireWalkAway(button) {
    if (!button) return;
    labelWalkAway(button, (pending && pending.exe) || "");
    button.addEventListener("click", walkAway);
}

// The good outcome, and the one the whole product is arranged around. It is a
// stand, and it counts exactly as a stand in the browser counts.
async function walkAway() {
    if (answered) return;
    // Nothing to answer for: close rather than strand the user behind a gate
    // that cannot say what it is guarding.
    if (!(await ready())) return native.closeGate();
    if (answered) return;
    answered = true;

    walkBtn.disabled = true;
    unlockBtn.disabled = true;

    await record({ type: "stand" });

    // Walking away means the program goes away. Asked before the gate closes,
    // because the grace that keeps a "save changes?" prompt from being
    // minimized is marked by the same call.
    await native.closeProgram((pending && pending.exe) || "");

    await native.closeGate();
}

// ---- Unlocking ------------------------------------------------------------

function fortressTask() {
    const fortress = (peer.state && peer.state.fortress) || {};
    return fortress.task || null;
}

function fortressCooldown() {
    const fortress = (peer.state && peer.state.fortress) || {};
    return normalizeCooldown(fortress.cooldown);
}

// Today's unlocks of this same program, which is what escalation counts. Read
// from the event log rather than a stored number, for the reason
// deriveEscalation() exists: a count that is merged rather than derived stops
// being idempotent the moment there are two devices.
function priorUnlocks(exe) {
    const state = peer.state || {};
    const today = state.today || localDateString(new Date());
    const counts = deriveEscalation(state.events || [], today);
    return Math.max(0, Number(counts[exe]) || 0);
}

async function beginUnlock() {
    if (answered) return;
    if (!(await ready())) return native.closeGate();

    actions.hidden = true;
    const task = fortressTask();

    if (!task) return beginCooldown(null);

    if (task.type === "cooldown") {
        return typingChallenge({
            instruction: "Type the message below exactly to begin your cooldown:",
            target: task.message || "",
            carryToHeading: true
        });
    }

    if (task.type === "passage") {
        return typingChallenge({
            instruction: "Type this passage exactly to begin your cooldown:",
            target: generatePassage(),
            carryToHeading: false
        });
    }

    if (task.type === "code") return codeChallenge(task.code || "");

    // A task saved by a newer version. Falling through to the plain cooldown
    // beats leaving a dead button on the one screen that must always have a
    // way out.
    return beginCooldown(null);
}

// Shared "retype this" challenge. Pasting is blocked: the target is on screen,
// so without that the task is one Ctrl+C away from meaningless.
function typingChallenge({ instruction, target, carryToHeading }) {
    taskArea.innerHTML = `
        <p class="task-instruction"></p>
        <p class="task-target"></p>
        <textarea id="taskInput" placeholder="Type it here..." rows="3"></textarea>
        <p class="task-error" id="taskError"></p>
        <div class="gate-actions">
            <button type="button" class="btn btn-quiet" id="taskBack">NEVER MIND</button>
            <button type="button" class="btn" id="taskConfirm">CONFIRM</button>
        </div>
    `;

    // textContent rather than interpolation: the reflection message is the
    // user's own words and has never been through an escape.
    taskArea.querySelector(".task-instruction").textContent = instruction;
    taskArea.querySelector(".task-target").textContent = target;

    const input = document.getElementById("taskInput");
    blockPasteOn(input);
    input.focus();

    wireWalkAway(document.getElementById("taskBack"));
    document.getElementById("taskConfirm").addEventListener("click", () => {
        if (input.value.trim() !== String(target).trim()) {
            document.getElementById("taskError").textContent = "That does not match. Try again.";
            return;
        }
        beginCooldown(carryToHeading ? target : null);
    });
}

function codeChallenge(code) {
    taskArea.innerHTML = `
        <p class="task-instruction">Enter the guarded code you wrote down:</p>
        <input type="text" id="taskInput" placeholder="CODE" autocomplete="off" />
        <p class="task-error" id="taskError"></p>
        <div class="gate-actions">
            <button type="button" class="btn btn-quiet" id="taskBack">NEVER MIND</button>
            <button type="button" class="btn" id="taskConfirm">CONFIRM</button>
        </div>
    `;

    const input = document.getElementById("taskInput");
    blockPasteOn(input);
    input.focus();

    wireWalkAway(document.getElementById("taskBack"));
    document.getElementById("taskConfirm").addEventListener("click", () => {
        if (input.value.trim().toUpperCase() !== String(code).trim().toUpperCase()) {
            document.getElementById("taskError").textContent = "That is not the code.";
            return;
        }
        beginCooldown(null);
    });
}

function beginCooldown(headingMessage) {
    const exe = (pending && pending.exe) || "";
    const cooldown = fortressCooldown();
    const prior = priorUnlocks(exe);
    const seconds = effectiveCooldownSeconds(cooldown, prior);

    // Escalation only deters if it is visible. Saying so beats silently
    // handing someone a longer wait than last time.
    const note = (cooldown.escalate && prior > 0)
        ? `Unlock #${prior + 1} of ${displayName(exe)} today — cooldown raised to ${formatHuman(seconds)}.`
        : "";

    countdown(seconds, headingMessage, note);
}

function countdown(totalSeconds, headingMessage, note) {
    if (headingMessage) heading.textContent = headingMessage;

    // Not cleared. The wait is the whole mechanism, and a countdown with
    // nothing above it reads as a loading spinner — something being done TO
    // you rather than something you are doing.
    lineEl.textContent = "The wait is the point. Go and do something else.";

    taskArea.innerHTML = `
        <p class="countdown-note"></p>
        <p class="countdown-clock" id="countdownClock">--:--</p>
        <div class="gate-actions">
            <button type="button" class="btn btn-quiet" id="taskBack">WALK AWAY</button>
            <button type="button" class="btn" id="taskUnlock" disabled>UNLOCK</button>
        </div>
    `;
    taskArea.querySelector(".countdown-note").textContent = note;

    const clock = document.getElementById("countdownClock");
    const unlock = document.getElementById("taskUnlock");
    wireWalkAway(document.getElementById("taskBack"));

    let left = totalSeconds;
    clock.textContent = formatClock(left);

    const timer = setInterval(() => {
        left -= 1;
        clock.textContent = formatClock(Math.max(0, left));

        if (left <= 0) {
            clearInterval(timer);
            clock.textContent = "00:00";
            unlock.disabled = false;
            unlock.focus();
        }
    }, 1000);

    // The browser's gate pauses its countdown when the tab is hidden, because a
    // hidden tab is one the user walked away from. This one deliberately does
    // not: the gate is a separate always-on-top window, and the program it is
    // standing in front of is minimized. Alt-tabbing away from it to keep
    // working is exactly the behaviour Dominus wants, and pausing the clock
    // would punish it.
    unlock.addEventListener("click", () => grant());
}

const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

async function grant() {
    if (answered) return;
    answered = true;

    const exe = (pending && pending.exe) || "";
    const expiry = Date.now() + UNLOCK_WINDOW_MS;

    await record({ type: "unlock", domain: exe, expiry: expiry });

    // Rust is told last, and only after the record is written. If the write
    // failed, nothing here opens the gate — the stricter order is the one that
    // cannot leave a program unblocked with no unlock behind it.
    await pushEnforced();
    await native.closeGate();
}

// ---- Recording ------------------------------------------------------------

// Appends to this app's copy of the state and commits it. The extension merges
// it in on its next tick, and the union is by event id, so it cannot
// double-count however many times the two reconcile.
async function record({ type, domain, expiry }) {
    if (!peer.state) return;

    const now = new Date();
    const state = peer.state;

    const event = {
        id: (window.crypto && window.crypto.randomUUID)
            ? window.crypto.randomUUID()
            : `app-${now.getTime()}-${Math.random().toString(16).slice(2)}`,
        type: type,
        device: peer.device || "",
        at: now.getTime(),
        // The LOCAL date and time of this machine, not derived from `at`. The
        // same reasoning as normalizeEvent(): a slip at 1am belongs to the day
        // it felt like.
        date: localDateString(now),
        time: localTimeString(now)
    };

    if (domain) event.domain = domain;

    const next = Object.assign({}, state, {
        events: (state.events || []).concat([event])
    });

    if (type === "unlock" && domain) {
        next.tempUnlocks = Object.assign({}, state.tempUnlocks || {}, { [domain]: expiry });
    }

    // The counters are this device's running totals, and they exist so a stand
    // survives its event being pruned in a year's time. Raised here for the
    // same reason recordSyncEvent() raises them there.
    if (type === "stand" || type === "unlock") {
        const counters = Object.assign({}, state.counters || {});
        const held = Object.assign({ stands: 0, unlocks: 0 }, counters[event.device] || {});
        if (type === "stand") held.stands += 1;
        else held.unlocks += 1;
        counters[event.device] = held;
        next.counters = counters;
    }

    const written = await native.putState(peer.stateRev, next);

    if (written === null) {
        // A sync landed underneath it, so nothing was written. Re-read and try
        // once. Losing a stand is a worse outcome than recording one twice —
        // and it cannot be recorded twice, because the event carries an id.
        peer = await native.peerState();
        if (!peer.state) return;
        const retry = Object.assign({}, peer.state, {
            events: (peer.state.events || []).concat([event])
        });
        if (type === "unlock" && domain) {
            retry.tempUnlocks = Object.assign({}, peer.state.tempUnlocks || {}, { [domain]: expiry });
        }
        const second = await native.putState(peer.stateRev, retry);
        if (second !== null) {
            peer = { stateRev: second, state: retry, device: peer.device };
        }
        return;
    }

    peer = { stateRev: written, state: next, device: peer.device };
}

// Hands Rust the list and the expiries, derived from the state this window is
// holding. Nothing on the Rust side works any of this out for itself.
//
// Built by enforcementFor() in the shared layer, the same function the main
// window uses. This used to be a hand-built copy of the old shape, and sending
// that after an unlock would have wiped every allowance from the watcher.
async function pushEnforced() {
    if (!peer.state) return;
    await native.setEnforced(enforcementFor(peer.state, localDateString(new Date())));
}

// ---- Wiring ---------------------------------------------------------------

walkBtn.addEventListener("click", walkAway);
unlockBtn.addEventListener("click", beginUnlock);

// Escape is walking away, because it is what Escape means everywhere else and
// because the alternative — a gate that ignores it — teaches people to reach
// for the taskbar instead.
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") walkAway();
});

// Rust emits this whenever it raises the gate. The window is built once and
// reused, so it has to be told each time rather than reading itself at load.
//
// The event is a fast path, not the only path. It once silently never arrived —
// the gate window was missing from the capability that permits listening — and
// a gate that depends on one message arriving is a gate whose buttons stop
// working the second time. So it also asks for itself whenever it is shown.
if (window.__TAURI__ && window.__TAURI__.event) {
    Promise.resolve()
        .then(() => window.__TAURI__.event.listen("gate-raised", (message) => open(message.payload)))
        .catch(() => { /* covered by syncWithNative() below */ });
}

// Asks Rust what the gate is standing in front of, and opens it if that is a
// different raise from the one on screen. Each raise carries its own `at`, so a
// second gate for the same program is still recognised as new.
async function syncWithNative() {
    const next = await native.pendingGate();
    if (!next) return;
    if (pending && pending.exe === next.exe && pending.at === next.at) return;
    await open(next);
}

// On load, which covers the first raise; and whenever the window comes forward,
// which is what raise_gate() does every time — show, then focus.
syncWithNative();
window.addEventListener("focus", () => syncWithNative());
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncWithNative();
});
