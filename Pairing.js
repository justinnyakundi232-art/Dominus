// Pairing.js — the pairing panel on The Seal.
//
// The UI half of LocalPeer.js, kept apart from it for the same reason
// Backup.js is kept apart from Sync.js: LocalPeer runs in the service worker,
// which has no DOM, and a file that touches `document` cannot be
// importScripts'd there.

function renderPairingPanel() {
    const input = document.getElementById("pairCodeInput");
    const submit = document.getElementById("pairSubmit");
    const forget = document.getElementById("pairForget");
    const status = document.getElementById("pairStatus");
    if (!input || !submit || !forget || !status) return;

    // The code is six characters read off another screen. Upper-casing as it is
    // typed means what is on the screen matches what is in the app, and the
    // user never wonders whether case matters. It doesn't — the app compares
    // case-insensitively — but looking wrong is enough to make someone retype.
    input.addEventListener("input", () => {
        input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit.click();
    });

    submit.addEventListener("click", () => {
        setPairStatus(status, "Looking for the app…");
        submit.disabled = true;

        pairWithLocalPeer(input.value)
            .then((result) => {
                if (result.paired) {
                    input.value = "";
                    setPairStatus(status, "Paired. This fortress will appear in the app shortly.");
                    // A commit or a stand would have reached the app on the next
                    // tick anyway; going now means the app has something to show
                    // by the time the user switches to it.
                    if (typeof syncNow === "function") syncNow();
                } else {
                    setPairStatus(status, result.reason, true);
                }
                return refreshPairingState();
            })
            .catch(() => setPairStatus(status, "Something went wrong. Try again.", true))
            .then(() => { submit.disabled = false; });
    });

    forget.addEventListener("click", () => {
        unpairLocalPeer()
            .then(() => {
                setPairStatus(status, "Forgotten. The app keeps whatever it already had.");
                return refreshPairingState();
            });
    });

    refreshPairingState();
}

// Which half of the panel is showing: the code box, or the paired state.
function refreshPairingState() {
    const unpaired = document.getElementById("pairUnpaired");
    const paired = document.getElementById("pairPaired");
    const state = document.getElementById("pairState");
    if (!unpaired || !paired || !state) return Promise.resolve();

    return localPeerStatus().then((peer) => {
        unpaired.hidden = peer.paired;
        paired.hidden = !peer.paired;

        if (peer.paired) {
            const when = peer.pairedAt
                ? new Date(peer.pairedAt).toLocaleDateString()
                : "unknown";
            state.textContent =
                `Paired with the app on this machine since ${when}, over port ${peer.port}.`;
        }
    });
}

function setPairStatus(el, text, isError) {
    el.textContent = text;
    el.classList.toggle("is-error", isError === true);
}

document.addEventListener("DOMContentLoaded", renderPairingPanel);
