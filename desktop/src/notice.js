// notice.js — "a few minutes left".
//
// Rust decides when a reminder is due and shows this window without focusing
// it; this only fills in the words and puts itself away. It reads the program's
// name from the synced state rather than being told it, for the same reason the
// gate does: the watcher knows executables, not names.

const titleEl = document.getElementById("noticeTitle");
const lineEl = document.getElementById("noticeLine");
const closeBtn = document.getElementById("noticeClose");

// Long enough to read twice, short enough not to linger over whatever it sits
// on. Hovering holds it, so a slow reader is not chased off.
const SHOW_FOR_MS = 12 * 1000;

let current = null;
let timer = null;

function invoke(command, args) {
    if (!(window.__TAURI__ && window.__TAURI__.core)) return Promise.resolve(null);
    return window.__TAURI__.core.invoke(command, args).catch(() => null);
}

async function programName(exe) {
    const peer = await invoke("peer_state");
    const fortress = (peer && peer.state && peer.state.fortress) || {};
    const application = findApplication(fortress.applications, exe);
    return (application && application.name) || applicationDisplayName(exe) || exe;
}

function minutesLeft(seconds) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return minutes === 1 ? "1 minute" : minutes + " minutes";
}

async function show(notice) {
    if (!notice) return;
    if (current && current.exe === notice.exe && current.at === notice.at) return;
    current = notice;

    const name = await programName(notice.exe);
    titleEl.textContent = minutesLeft(notice.remaining_secs) + " of " + name + " left";
    lineEl.textContent = "When today's time runs out, Dominus will put it away.";

    armTimer();
}

function armTimer() {
    clearTimeout(timer);
    timer = setTimeout(dismiss, SHOW_FOR_MS);
}

function dismiss() {
    clearTimeout(timer);
    current = null;
    invoke("close_notice");
}

closeBtn.addEventListener("click", dismiss);

document.body.addEventListener("mouseenter", () => clearTimeout(timer));
document.body.addEventListener("mouseleave", armTimer);

if (window.__TAURI__ && window.__TAURI__.event) {
    Promise.resolve()
        .then(() => window.__TAURI__.event.listen("notice-raised", (message) => show(message.payload)))
        .catch(() => { /* covered by asking on show, below */ });
}

// Not dependent on the event: a window shown without focus never gets a focus
// event, so it asks whenever it becomes visible, and once at load.
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) invoke("pending_notice").then(show);
});
invoke("pending_notice").then(show);
