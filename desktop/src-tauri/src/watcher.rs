// watcher.rs — the only part of Dominus that can see a program.
//
// The reasoning is in ../APP-LIMITS.md. What matters here:
//
//   - This runs in Rust rather than in the window because the webview is
//     throttled when it is hidden, and Dominus is meant to spend most of its
//     life hidden in the tray. Enforcement that stops working when nobody is
//     looking at it is not enforcement.
//
//   - It holds an *enforcement view* and nothing else: a list of executables
//     and a map of unlock expiries, pushed here by the window whenever the
//     fortress changes. It has no merge rules, no authoring rules, and no
//     opinion about what ought to be blocked. Same division as everywhere else
//     in this protocol — every rule in the system is written once, in Sync.js.
//
//   - It never records anything. It cannot write a stand, an unlock or a
//     fortress edit. It raises a gate and reports what it stopped; the window
//     does the rest, through Sync.js.
//
// The window is minimized rather than the process killed. Killing can lose
// unsaved work and designs against the user, which is the one thing Dominus has
// never done — see "What happens when you open a blocked application".

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// How often the foreground is checked.
///
/// Chosen against two failure modes. Faster is a poll that runs tens of
/// thousands of times a day for someone who has blocked nothing. Slower and
/// there is a visible pause between clicking Steam and being stopped, which
/// reads as a bug rather than as a gate.
pub const POLL_INTERVAL_MS: u64 = 1000;

/// What the window has told this side to enforce.
///
/// Executables only — lowercased basenames. Deliberately not the application
/// entries themselves: the thing doing the enforcing has no business knowing an
/// application's name, whether it is permanent, or anything else it might be
/// tempted to make a decision with.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Enforced {
    #[serde(default)]
    pub blocked: Vec<String>,
    /// exe -> epoch milliseconds. An entry in the past is expired and is
    /// treated exactly like an absent one, so a stale map can never be the
    /// reason something is let through.
    #[serde(default)]
    pub unlocked_until: HashMap<String, u64>,
}

impl Enforced {
    /// Is this executable behind a gate right now?
    ///
    /// Both halves are read at the same instant on purpose. Asking "is it
    /// blocked" and "is it unlocked" as two separate questions, a second apart,
    /// is how a gate opens for one tick during an expiry.
    pub fn gated(&self, exe: &str, now: u64) -> bool {
        if !self.blocked.iter().any(|name| name == exe) {
            return false;
        }
        match self.unlocked_until.get(exe) {
            Some(until) => *until <= now,
            None => true,
        }
    }
}

/// What the watcher has stopped and has not yet been told the outcome of.
///
/// One at a time, and only ever the foreground. Two gates for two programs
/// would be two windows asking for two passwords about a thing the user is not
/// even looking at.
#[derive(Clone, Serialize)]
pub struct PendingGate {
    pub exe: String,
    /// Milliseconds since epoch, so the window can say how long ago rather than
    /// guessing that the gate went up the instant it was asked.
    pub at: u64,
}

#[derive(Default)]
pub struct WatchInner {
    pub enforced: Enforced,
    /// Where `enforced` is kept between runs.
    ///
    /// It has to survive, and the reason is a narrow one: the window is what
    /// tells this side what to enforce, and on a cold start the window has not
    /// spoken yet. Dominus and Steam can both be set to start with the machine,
    /// and the seconds before the webview finishes loading are exactly the
    /// seconds a blocked program would get through for free.
    ///
    /// This is a cache of what the window last said, not an interpretation of
    /// the fortress. Nothing here reads `state`, and that is the line worth
    /// keeping — the moment this side starts deriving what to block, there are
    /// two implementations of the rules again.
    store: Option<PathBuf>,
    pub pending: Option<PendingGate>,
    /// What was in the foreground last tick.
    ///
    /// The gate is raised on a *transition* into a blocked program, not on
    /// finding one there. Without this, every tick would re-raise a gate the
    /// user is in the middle of reading, and walking away would be impossible
    /// because the program is still the foreground of a machine nobody is
    /// touching.
    last_seen: Option<String>,
    /// Set while the user is deciding. Nothing is gated again until the window
    /// says the gate is closed, so a second poll cannot stack a second gate on
    /// top of the first.
    open: bool,
}

pub type Watch = Arc<Mutex<WatchInner>>;

impl WatchInner {
    /// Decides what to do about whatever is in the foreground.
    ///
    /// Pure: it takes the executable and the clock and returns a verdict. The
    /// Win32 calls are in `foreground()` below, and the tick that joins them is
    /// the only impure part — which is what lets the interesting half of this
    /// file be tested without a desktop anywhere near it.
    pub fn observe(&mut self, exe: Option<&str>, now: u64) -> bool {
        let current = exe.map(|name| name.to_string());

        // Leaving the program is what re-arms the gate. Coming back to it is a
        // new decision, and deserves to be asked about again.
        let changed = current != self.last_seen;
        self.last_seen = current.clone();

        let Some(exe) = current else { return false };

        if self.open {
            return false;
        }
        if !changed {
            return false;
        }
        if !self.enforced.gated(&exe, now) {
            return false;
        }

        self.pending = Some(PendingGate {
            exe: exe.clone(),
            at: now,
        });
        self.open = true;
        true
    }

    /// The window has finished with the gate, whichever way it went.
    ///
    /// `last_seen` is deliberately left alone. The blocked program is still
    /// nominally the foreground as far as the last poll knew, and clearing it
    /// would make the very next tick look like a fresh arrival and raise the
    /// gate again on a decision that was just made.
    pub fn close_gate(&mut self) {
        self.pending = None;
        self.open = false;
    }

    pub fn set_enforced(&mut self, enforced: Enforced) {
        self.enforced = enforced;
        self.persist();
    }

    /// Points at a file and loads whatever is there.
    ///
    /// A missing or unreadable file is a first run, and it is also the safest
    /// reading of a corrupted one: starting with nothing enforced means the
    /// window fills it in a second later, where starting with half a list means
    /// enforcing half a fortress and never being told.
    pub fn attach(&mut self, path: PathBuf) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(saved) = serde_json::from_str::<Enforced>(&text) {
                self.enforced = saved;
            }
        }
        self.store = Some(path);
    }

    /// Through a temporary file and a rename, like service.rs does, and for the
    /// same reason: a half-written list is a fortress that enforces some of
    /// itself.
    fn persist(&self) {
        let Some(path) = &self.store else { return };
        let Ok(text) = serde_json::to_string(&self.enforced) else {
            return;
        };

        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let temp = path.with_extension("tmp");
        if std::fs::write(&temp, text).is_ok() {
            let _ = std::fs::rename(&temp, path);
        }
    }
}

// ---- Seeing the foreground ------------------------------------------------
//
// Everything below is per-platform and does no deciding.

/// The foreground window's executable basename, lowercased, and the handle it
/// came from so it can be minimized.
///
/// `None` covers every ordinary failure: no foreground window at all (a locked
/// screen, a desktop switch), a process this app is not allowed to ask about, a
/// path that does not decode. None of those are errors worth surfacing — they
/// mean "nothing to do this tick", and the next one is a second away.
#[cfg(target_os = "windows")]
pub fn foreground() -> Option<(String, isize)> {
    use windows_sys::Win32::Foundation::{CloseHandle, MAX_PATH};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }

        // The least privilege that answers the question. PROCESS_QUERY_INFORMATION
        // would also work and would additionally fail against anything running
        // at a higher integrity level, which would mean Dominus had to be
        // elevated to see that a game was open.
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }

        let mut buffer = [0u16; MAX_PATH as usize];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut len);
        CloseHandle(handle);

        if ok == 0 || len == 0 {
            return None;
        }

        let path = String::from_utf16_lossy(&buffer[..len as usize]);
        let name = basename(&path);
        if name.is_empty() {
            return None;
        }

        Some((name, hwnd as isize))
    }
}

#[cfg(not(target_os = "windows"))]
pub fn foreground() -> Option<(String, isize)> {
    // Applications are Windows-only in Phase 3. The rest of this file compiles
    // and is tested everywhere, so the day a second platform arrives it needs
    // this function and nothing else.
    None
}

/// Minimizes a window by handle.
///
/// Returns whether anything was asked of it, not whether the user is now
/// looking at something else — a window can refuse, and a window that refuses
/// is not a reason to escalate to something harsher.
#[cfg(target_os = "windows")]
pub fn minimize(hwnd: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_MINIMIZE};

    if hwnd == 0 {
        return false;
    }
    unsafe {
        ShowWindow(hwnd as *mut core::ffi::c_void, SW_MINIMIZE);
    }
    true
}

#[cfg(not(target_os = "windows"))]
pub fn minimize(_hwnd: isize) -> bool {
    false
}

/// The basename of a path, lowercased.
///
/// The same rule as `normalizeExecutable()` in Applications.js, and it has to
/// stay the same rule: the string this produces is matched against the list
/// that one produces, and a disagreement between them is a block that silently
/// does nothing. Both separators, because the two are written on the same
/// machine but read on either.
pub fn basename(path: &str) -> String {
    path.rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enforced(blocked: &[&str]) -> Enforced {
        Enforced {
            blocked: blocked.iter().map(|s| s.to_string()).collect(),
            unlocked_until: HashMap::new(),
        }
    }

    fn watch(blocked: &[&str]) -> WatchInner {
        WatchInner {
            enforced: enforced(blocked),
            ..Default::default()
        }
    }

    #[test]
    fn basename_matches_the_javascript_rule() {
        // If these two ever disagree, a blocked program silently stops being
        // blocked, so this is checked against the same cases Applications.js is.
        assert_eq!(basename("C:\\Program Files (x86)\\Steam\\Steam.exe"), "steam.exe");
        assert_eq!(basename("/Applications/Steam/steam"), "steam");
        assert_eq!(basename("STEAM.EXE"), "steam.exe");
        assert_eq!(basename(""), "");
    }

    #[test]
    fn a_blocked_program_raises_the_gate_once() {
        let mut w = watch(&["steam.exe"]);
        assert!(w.observe(Some("steam.exe"), 1_000), "the gate did not go up");
        assert!(!w.observe(Some("steam.exe"), 2_000), "a second gate stacked on the first");
        assert_eq!(w.pending.as_ref().unwrap().exe, "steam.exe");
    }

    #[test]
    fn leaving_and_coming_back_is_a_new_decision() {
        let mut w = watch(&["steam.exe"]);
        assert!(w.observe(Some("steam.exe"), 1_000));
        w.close_gate();

        // Still there, and the user has just answered for it.
        assert!(!w.observe(Some("steam.exe"), 2_000), "the gate re-raised on a settled decision");

        assert!(!w.observe(Some("code.exe"), 3_000));
        assert!(w.observe(Some("steam.exe"), 4_000), "coming back was not asked about");
    }

    #[test]
    fn nothing_happens_to_a_program_that_is_not_blocked() {
        let mut w = watch(&["steam.exe"]);
        assert!(!w.observe(Some("code.exe"), 1_000));
        assert!(w.pending.is_none());
    }

    #[test]
    fn a_live_unlock_lets_it_through_and_an_expired_one_does_not() {
        let mut w = watch(&["steam.exe"]);
        w.enforced
            .unlocked_until
            .insert("steam.exe".to_string(), 5_000);

        assert!(!w.observe(Some("steam.exe"), 1_000), "an unlock that was paid for was ignored");

        // Expiry is inclusive: at the stated millisecond the window is over.
        assert!(!w.observe(Some("code.exe"), 4_000));
        assert!(w.observe(Some("steam.exe"), 5_000), "an expired unlock kept letting it through");
    }

    #[test]
    fn an_empty_fortress_gates_nothing() {
        let mut w = WatchInner::default();
        assert!(!w.observe(Some("steam.exe"), 1_000));
    }

    #[test]
    fn what_to_enforce_survives_a_restart() {
        // The gap this closes: Dominus and Steam both starting with the
        // machine, and the webview taking a second to say what is blocked.
        let dir = std::env::temp_dir().join(format!("dominus-watch-{}", std::process::id()));
        let path = dir.join("enforced.json");
        let _ = std::fs::remove_dir_all(&dir);

        let mut before = WatchInner::default();
        before.attach(path.clone());
        before.set_enforced(enforced(&["steam.exe"]));

        let mut after = WatchInner::default();
        after.attach(path.clone());
        assert!(after.observe(Some("steam.exe"), 1_000), "a cold start let it through");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_a_first_run_and_not_an_error() {
        let mut w = WatchInner::default();
        w.attach(std::env::temp_dir().join("dominus-watch-nothing-here/enforced.json"));
        assert!(w.enforced.blocked.is_empty());
        assert!(!w.observe(Some("steam.exe"), 1_000));
    }

    #[test]
    fn losing_the_foreground_entirely_is_not_an_event() {
        // A locked screen or a desktop switch. It must not count as leaving the
        // program in a way that re-arms the gate on the way back in the same
        // tick, and it must certainly not raise one.
        let mut w = watch(&["steam.exe"]);
        assert!(!w.observe(None, 1_000));
        assert!(w.pending.is_none());
        assert!(w.observe(Some("steam.exe"), 2_000));
    }
}
