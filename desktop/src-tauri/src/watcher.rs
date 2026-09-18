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

/// The most one tick may bill.
///
/// The time between two ticks is what a program in front is charged, and that
/// is normally a second. After a sleep or a stalled thread it can be hours, and
/// charging those to whatever was in front when the laptop lid closed would
/// spend an allowance nobody used.
pub const MAX_TICK_MS: u64 = 3 * POLL_INTERVAL_MS;

/// How long the gate stands aside for a program it asked to close.
///
/// Long enough to answer "save changes?" without hurrying, short enough that it
/// is no use as a way through. It is not an unlock: nothing is recorded, and
/// when it lapses the program is gated again exactly as it was.
pub const CLOSE_GRACE_MS: u64 = 30_000;

/// A program allowed some time a day. Seconds, because seconds are what the
/// watcher counts in; the window converts from the minutes a person set.
#[derive(Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allowance {
    pub allowance_secs: u64,
    /// How long before the allowance runs out the reminder appears. 0 for none.
    #[serde(default)]
    pub warn_secs: u64,
}

/// What the window has told this side to enforce.
///
/// Executables and numbers — lowercased basenames, seconds, a date. Deliberately
/// not the application entries themselves: the thing doing the enforcing has no
/// business knowing an application's name, whether it is permanent, or anything
/// else it might be tempted to make a decision with.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Enforced {
    /// Blocked outright.
    #[serde(default)]
    pub blocked: Vec<String>,
    /// exe -> epoch milliseconds. An entry in the past is expired and is
    /// treated exactly like an absent one, so a stale map can never be the
    /// reason something is let through.
    #[serde(default)]
    pub unlocked_until: HashMap<String, u64>,
    /// Programs allowed some time a day. Never also in `blocked`.
    #[serde(default)]
    pub allowances: HashMap<String, Allowance>,
    /// Seconds each program has spent in front on `day`, as the window last
    /// worked out from the event log — every device's time, and this one's up
    /// to the last time the window collected it.
    #[serde(default)]
    pub spent: HashMap<String, u64>,
    /// The local date `spent` is for, as the window names it. This side never
    /// works out what day it is; "what day is it here" is answered in one place
    /// in this project, and it is not here.
    #[serde(default)]
    pub day: String,
}

/// Time counted here and not yet in the event log, for one program on one day.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct UsageSlice {
    pub day: String,
    pub exe: String,
    pub seconds: u64,
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

/// A reminder that an allowance is nearly spent.
#[derive(Clone, Serialize, PartialEq, Eq, Debug)]
pub struct Notice {
    pub exe: String,
    /// Seconds of today's allowance left when the notice was raised.
    pub remaining_secs: u64,
    pub at: u64,
}

/// What a tick decided. The tick itself does the Win32 half.
#[derive(Default, PartialEq, Eq, Debug)]
pub struct Verdict {
    pub raise_gate: bool,
    pub notice: Option<Notice>,
}

/// What is kept in `enforced.json`: what the window last said, and the time
/// counted since it last collected any. Read from files written before
/// allowances existed, which hold `Enforced` alone — the flattened fields are
/// exactly that shape, and `pending` defaults to nothing.
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(flatten)]
    enforced: Enforced,
    #[serde(default)]
    pending: Vec<UsageSlice>,
}

#[derive(Default)]
pub struct WatchInner {
    pub enforced: Enforced,
    /// Where `enforced` and `pending` are kept between runs.
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
    /// Counted, not yet collected by the window.
    usage: Vec<UsageSlice>,
    /// Collected by the window, not yet reflected in a push. Still counted, so
    /// the gap between the window taking time and pushing the total that
    /// includes it is not a moment when that time stops existing. Cleared by
    /// the next push, which is the one that includes it.
    inflight: Vec<UsageSlice>,
    /// What was in the foreground last tick, and when that tick was.
    ///
    /// The gate is raised on a *transition* into a blocked program, not on
    /// finding one there. Without this, every tick would re-raise a gate the
    /// user is in the middle of reading, and walking away would be impossible
    /// because the program is still the foreground of a machine nobody is
    /// touching.
    last_seen: Option<String>,
    last_tick: Option<u64>,
    /// Whether `last_seen` was gated last tick. A program with an allowance can
    /// run out while it is already in front, with no arrival to notice; this is
    /// what lets that moment raise the gate without every later tick raising
    /// it again.
    was_gated: bool,
    /// Set while the user is deciding. Nothing is gated again until the window
    /// says the gate is closed, so a second poll cannot stack a second gate on
    /// top of the first.
    open: bool,
    /// Reminders already given: (day, exe) -> the allowance they were given
    /// for. Changing the allowance or the warning arms the reminder again.
    warned: HashMap<(String, String), Allowance>,
    pub notice: Option<Notice>,
    /// Programs asked to close, and the instant the gate stops standing aside
    /// for them. See `mark_closing()`.
    closing: HashMap<String, u64>,
}

pub type Watch = Arc<Mutex<WatchInner>>;

impl WatchInner {
    /// Seconds `exe` has spent in front today, counting everything this side
    /// knows about: what the window last pushed, what it has taken since, and
    /// what has been counted since that.
    pub fn spent(&self, exe: &str) -> u64 {
        let day = &self.enforced.day;
        let local: u64 = self
            .usage
            .iter()
            .chain(self.inflight.iter())
            .filter(|slice| &slice.day == day && slice.exe == exe)
            .map(|slice| slice.seconds)
            .sum();
        self.enforced.spent.get(exe).copied().unwrap_or(0) + local
    }

    /// Every program with an allowance, and how much of it is gone.
    pub fn spent_today(&self) -> HashMap<String, u64> {
        self.enforced
            .allowances
            .keys()
            .map(|exe| (exe.clone(), self.spent(exe)))
            .collect()
    }

    /// Stands the gate aside for `exe` while it shuts down.
    ///
    /// Walking away now asks the program to close, and a program being asked to
    /// close often has a question of its own: save changes? That question is a
    /// window belonging to the same executable, so without this the next poll
    /// would minimize it — and the user would be back in the loop this was
    /// meant to end, now unable to answer a prompt about their own work.
    ///
    /// Deliberately short, and deliberately a grace rather than an unlock:
    /// nothing is recorded, no allowance is spent against it, and when it
    /// lapses the program is gated again exactly as before. A program that
    /// refused to close is back where it started, which is the honest outcome.
    pub fn mark_closing(&mut self, exe: &str, now: u64) {
        if exe.is_empty() {
            return;
        }
        self.closing.insert(exe.to_string(), now + CLOSE_GRACE_MS);
        // Whatever was in front is going away; the next arrival is a new
        // decision and deserves to be asked about again.
        self.was_gated = false;
    }

    /// Whether the gate is currently standing aside for `exe`. Lapsed entries
    /// are dropped as they are found, so the map cannot grow without bound.
    fn closing(&mut self, exe: &str, now: u64) -> bool {
        match self.closing.get(exe) {
            Some(until) if *until > now => true,
            Some(_) => {
                self.closing.remove(exe);
                false
            }
            None => false,
        }
    }

    /// Is this executable behind a gate right now?
    ///
    /// Blocked outright, or out of time — unless an unlock is live. Every part
    /// is read at the same instant on purpose: asking them as separate
    /// questions a second apart is how a gate opens for one tick at an edge.
    pub fn gated(&self, exe: &str, now: u64) -> bool {
        if let Some(until) = self.enforced.unlocked_until.get(exe) {
            if *until > now {
                return false;
            }
        }
        if self.enforced.blocked.iter().any(|name| name == exe) {
            return true;
        }
        match self.enforced.allowances.get(exe) {
            Some(allowance) => self.spent(exe) >= allowance.allowance_secs,
            None => false,
        }
    }

    /// Bills the time since the last tick to whatever was in front for it.
    fn accrue(&mut self, now: u64) {
        let elapsed = match self.last_tick {
            Some(then) if now > then => (now - then).min(MAX_TICK_MS),
            _ => 0,
        };
        self.last_tick = Some(now);

        let Some(exe) = self.last_seen.clone() else { return };
        if elapsed == 0 || !self.enforced.allowances.contains_key(&exe) || self.enforced.day.is_empty() {
            return;
        }

        // Carried as milliseconds would be exact; seconds are what the event
        // log holds, and a tick is a second, so rounding each tick is the
        // honest unit.
        let seconds = (elapsed + 500) / 1000;
        if seconds == 0 {
            return;
        }

        let day = self.enforced.day.clone();
        match self.usage.iter_mut().find(|slice| slice.day == day && slice.exe == exe) {
            Some(slice) => slice.seconds += seconds,
            None => self.usage.push(UsageSlice { day, exe, seconds }),
        }
    }

    /// Decides what to do about whatever is in the foreground.
    ///
    /// Pure: it takes the executable and the clock and returns a verdict. The
    /// Win32 calls are in `foreground()` below, and the tick that joins them is
    /// the only impure part — which is what lets the interesting half of this
    /// file be tested without a desktop anywhere near it.
    pub fn observe(&mut self, exe: Option<&str>, now: u64) -> Verdict {
        // Billed before anything moves: the time just gone belongs to whatever
        // was in front for it, not to whatever is in front now.
        self.accrue(now);

        let current = exe.map(|name| name.to_string());

        // Leaving the program is what re-arms the gate. Coming back to it is a
        // new decision, and deserves to be asked about again.
        let changed = current != self.last_seen;
        self.last_seen = current.clone();

        let mut verdict = Verdict::default();

        let Some(exe) = current else {
            self.was_gated = false;
            return verdict;
        };

        // Shutting down at our own request. Its windows — including whatever it
        // wants to ask about unsaved work — are left alone until the grace
        // lapses.
        if self.closing(&exe, now) {
            self.was_gated = false;
            return verdict;
        }

        let gated = self.gated(&exe, now);
        let became_gated = gated && !self.was_gated;
        self.was_gated = gated;

        if gated {
            if !self.open && (changed || became_gated) {
                self.pending = Some(PendingGate { exe: exe.clone(), at: now });
                self.open = true;
                // A reminder still on screen is about the thing that has now
                // happened. The gate says it better.
                self.notice = None;
                verdict.raise_gate = true;
            }
            return verdict;
        }

        verdict.notice = self.due_notice(&exe, now);
        if verdict.notice.is_some() {
            self.notice = verdict.notice.clone();
        }
        verdict
    }

    /// A reminder, if one is owed for `exe` and has not been given.
    fn due_notice(&mut self, exe: &str, now: u64) -> Option<Notice> {
        let allowance = *self.enforced.allowances.get(exe)?;
        if allowance.warn_secs == 0 {
            return None;
        }

        let spent = self.spent(exe);
        let remaining = allowance.allowance_secs.saturating_sub(spent);
        if remaining == 0 || remaining > allowance.warn_secs {
            return None;
        }

        // Once per program per day, unless the allowance or the warning has
        // changed since — a new limit is a new thing to be warned about.
        let key = (self.enforced.day.clone(), exe.to_string());
        if self.warned.get(&key) == Some(&allowance) {
            return None;
        }
        self.warned.insert(key, allowance);

        Some(Notice { exe: exe.to_string(), remaining_secs: remaining, at: now })
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

    pub fn close_notice(&mut self) {
        self.notice = None;
    }

    /// A new picture of what to enforce, from the window.
    ///
    /// Clears `inflight`: the window pushes after writing what it took, so this
    /// push is the one that includes it. A push that races ahead of that write
    /// undercounts by at most one collection — about a minute — until the next
    /// push. Only a crash overcounts; see persist().
    pub fn set_enforced(&mut self, enforced: Enforced) {
        self.enforced = enforced;
        self.inflight.clear();
        self.persist();
    }

    /// Hands the window everything counted since it last asked.
    pub fn take_usage(&mut self) -> Vec<UsageSlice> {
        let taken = std::mem::take(&mut self.usage);
        self.inflight.extend(taken.iter().cloned());
        self.persist();
        taken
    }

    /// The window could not write what it took. Back into the count, so the
    /// time is collected again next minute rather than lost.
    pub fn restore_usage(&mut self, slices: Vec<UsageSlice>) {
        for slice in slices {
            if let Some(pos) = self.inflight.iter().position(|held| *held == slice) {
                self.inflight.remove(pos);
            }
            match self.usage.iter_mut().find(|held| held.day == slice.day && held.exe == slice.exe) {
                Some(held) => held.seconds += slice.seconds,
                None => self.usage.push(slice),
            }
        }
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
            if let Ok(saved) = serde_json::from_str::<Saved>(&text) {
                self.enforced = saved.enforced;
                self.usage = saved.pending;
            }
        }
        self.store = Some(path);
    }

    /// Through a temporary file and a rename, like service.rs does, and for the
    /// same reason: a half-written list is a fortress that enforces some of
    /// itself.
    ///
    /// Time taken but not yet pushed back is saved as pending, so a crash
    /// before the window writes it collects it again rather than losing it.
    /// A crash in the narrower gap after the write and before the push counts
    /// that collection twice — about a minute, once. Of the two wrong answers
    /// that is the stricter one, which is the side this project errs on.
    fn persist(&self) {
        let Some(path) = &self.store else { return };
        let mut pending = self.usage.clone();
        pending.extend(self.inflight.iter().cloned());
        let saved = Saved { enforced: self.enforced.clone(), pending };
        let Ok(text) = serde_json::to_string(&saved) else {
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
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        exe_for_window(hwnd).map(|name| (name, hwnd as isize))
    }
}

/// The executable basename behind a window, lowercased. Shared by the watcher
/// and the picker, so the name a program is added under is exactly the name it
/// is later matched by.
#[cfg(target_os = "windows")]
unsafe fn exe_for_window(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, MAX_PATH};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == 0 {
        return None;
    }

    // The least privilege that answers the question. PROCESS_QUERY_INFORMATION
    // would also work and would additionally fail against anything running at a
    // higher integrity level, which would mean Dominus had to be elevated to see
    // that a game was open.
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

    let name = basename(&String::from_utf16_lossy(&buffer[..len as usize]));
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// A program the picker can offer: something with a window a person would
/// recognise, not one of the two hundred processes Windows runs behind them.
#[derive(Clone, Serialize)]
pub struct RunningApplication {
    pub exe: String,
    /// The title of one of its windows, so "chrome.exe" can be shown beside
    /// something the user actually recognises. Not stored anywhere.
    pub title: String,
}

/// Visible, titled, top-level, unowned, non-tool windows — the ones in the
/// taskbar — grouped by executable. That filter is what turns a process table
/// into a list of things someone has actually opened.
///
/// Protected executables are NOT filtered here. That is Applications.js's
/// decision, made where an application enters the fortress, and a second copy of
/// the list in Rust would be a second list to keep in step.
#[cfg(target_os = "windows")]
pub fn running_applications() -> Vec<RunningApplication> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
        IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> i32 {
        let found = &mut *(lparam as *mut Vec<RunningApplication>);

        if IsWindowVisible(hwnd) == 0 || !GetWindow(hwnd, GW_OWNER).is_null() {
            return 1;
        }
        if (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }

        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return 1;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        let title = String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
            .trim()
            .to_string();
        if title.is_empty() {
            return 1;
        }

        if let Some(exe) = exe_for_window(hwnd) {
            if !found.iter().any(|entry| entry.exe == exe) {
                found.push(RunningApplication { exe, title });
            }
        }
        1
    }

    let mut found: Vec<RunningApplication> = Vec::new();
    unsafe {
        EnumWindows(Some(visit), &mut found as *mut _ as LPARAM);
    }
    found.sort_by(|a, b| a.exe.cmp(&b.exe));
    found
}

#[cfg(not(target_os = "windows"))]
pub fn foreground() -> Option<(String, isize)> {
    // Applications are Windows-only in Phase 3. The rest of this file compiles
    // and is tested everywhere, so the day a second platform arrives it needs
    // this function and the two below, and nothing else.
    None
}

#[cfg(not(target_os = "windows"))]
pub fn running_applications() -> Vec<RunningApplication> {
    Vec::new()
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

/// Asks every top-level window belonging to `exe` to close, and says how many
/// were asked.
///
/// `WM_CLOSE` is a request, not a kill. It is the same message the X button
/// sends, so the program runs its own shutdown: it saves, it prompts about
/// unsaved work, and it is free to refuse outright. Nothing here escalates to
/// `TerminateProcess` when it does, and nothing ever should — walking away from
/// a game is not a reason to lose an unsaved document, and a discipline tool
/// that destroys work is a tool nobody can afford to trust. A program that
/// refuses simply stays open and stays gated, which is where this started.
///
/// Matched by executable name, so a program running as several processes —
/// a browser, anything with a helper per window — is asked as a whole. That is
/// what "close it" means to the person who asked.
///
/// See `mark_closing()` for why the gate then keeps out of its way for a
/// moment: a program asking "save changes?" needs an answer, and minimizing
/// that question is the same trap by another name.
#[cfg(target_os = "windows")]
pub fn close_windows(exe: &str) -> usize {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, IsWindowVisible, PostMessageW, GW_OWNER, WM_CLOSE,
    };

    struct Asking {
        exe: String,
        asked: usize,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> i32 {
        let asking = &mut *(lparam as *mut Asking);

        // Visible top-level windows only, by the same two tests
        // running_applications() uses. An owned window is a dialog belonging to
        // one of them and closes with its owner; asking it directly would be
        // answering a prompt on the user's behalf.
        if IsWindowVisible(hwnd) == 0 || !GetWindow(hwnd, GW_OWNER).is_null() {
            return 1;
        }

        match exe_for_window(hwnd) {
            Some(found) if found == asking.exe => {
                PostMessageW(hwnd, WM_CLOSE, 0 as WPARAM, 0 as LPARAM);
                asking.asked += 1;
            }
            _ => {}
        }
        1
    }

    if exe.is_empty() {
        return 0;
    }

    let mut asking = Asking { exe: exe.to_string(), asked: 0 };
    unsafe {
        EnumWindows(Some(visit), &mut asking as *mut _ as LPARAM);
    }
    asking.asked
}

#[cfg(not(target_os = "windows"))]
pub fn close_windows(_exe: &str) -> usize {
    0
}

/// Shows a window without making it the active one, on top of everything.
///
/// For the allowance reminder. Tauri's own `show()` activates the window,
/// which takes the keyboard away from whatever the user is doing — a game, a
/// document — and that is the interruption a reminder exists to avoid.
/// `SW_SHOWNOACTIVATE` shows it where it is without activating it, and
/// `SWP_NOACTIVATE` keeps the topmost placement from activating it either.
#[cfg(target_os = "windows")]
pub fn show_without_focus(hwnd: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
    };

    if hwnd == 0 {
        return false;
    }
    let handle = hwnd as *mut core::ffi::c_void;
    unsafe {
        ShowWindow(handle, SW_SHOWNOACTIVATE);
        SetWindowPos(
            handle,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
    }
    true
}

#[cfg(not(target_os = "windows"))]
pub fn show_without_focus(_hwnd: isize) -> bool {
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

    const DAY: &str = "2026-09-17";

    fn enforced(blocked: &[&str]) -> Enforced {
        Enforced {
            blocked: blocked.iter().map(|s| s.to_string()).collect(),
            day: DAY.to_string(),
            ..Default::default()
        }
    }

    fn watch(blocked: &[&str]) -> WatchInner {
        WatchInner {
            enforced: enforced(blocked),
            ..Default::default()
        }
    }

    /// A watcher with one program allowed `minutes`, warning `warn` before.
    fn allowed(exe: &str, minutes: u64, warn: u64) -> WatchInner {
        let mut e = enforced(&[]);
        e.allowances.insert(
            exe.to_string(),
            Allowance { allowance_secs: minutes * 60, warn_secs: warn * 60 },
        );
        WatchInner { enforced: e, ..Default::default() }
    }

    /// Holds `exe` in front for `seconds`, one tick a second, from `start`.
    /// Returns the verdicts that raised the gate or a notice, with their time.
    fn hold(w: &mut WatchInner, exe: &str, start: u64, seconds: u64) -> Vec<(u64, Verdict)> {
        let mut out = Vec::new();
        for i in 0..=seconds {
            let at = start + i * 1000;
            let verdict = w.observe(Some(exe), at);
            if verdict.raise_gate || verdict.notice.is_some() {
                out.push((at, verdict));
            }
        }
        out
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

    // ---- Standing aside while it closes ---------------------------------

    #[test]
    fn a_program_asked_to_close_is_left_alone_to_do_it() {
        // The save prompt belongs to the same executable. Minimizing it is the
        // loop this feature exists to end, wearing a different hat.
        let mut w = watch(&["notepad.exe"]);
        assert!(w.observe(Some("notepad.exe"), 1_000).raise_gate);
        w.close_gate();
        w.mark_closing("notepad.exe", 2_000);

        for at in [3_000, 10_000, 31_000] {
            assert!(
                !w.observe(Some("notepad.exe"), at).raise_gate,
                "the gate came back while the program was still shutting down"
            );
        }
    }

    #[test]
    fn a_program_that_refused_to_close_is_gated_again_when_the_grace_lapses() {
        // Cancelled the save prompt and carried on. Back where it started, once.
        let mut w = watch(&["notepad.exe"]);
        w.mark_closing("notepad.exe", 1_000);

        let lapsed = 1_000 + CLOSE_GRACE_MS + 1_000;
        assert!(!w.observe(Some("notepad.exe"), lapsed - 2_000).raise_gate);
        assert!(w.observe(Some("notepad.exe"), lapsed).raise_gate, "the grace never lapsed");
        assert!(
            !w.observe(Some("notepad.exe"), lapsed + 1_000).raise_gate,
            "a second gate stacked on the first"
        );
    }

    #[test]
    fn standing_aside_for_one_program_does_not_stand_aside_for_another() {
        let mut w = watch(&["notepad.exe", "steam.exe"]);
        w.mark_closing("notepad.exe", 1_000);
        assert!(w.observe(Some("steam.exe"), 2_000).raise_gate, "an unrelated program got through");
    }

    #[test]
    fn the_grace_is_not_an_unlock_and_spends_nothing() {
        // Two minutes allowed, all of it used, then asked to close. The grace
        // must not hand back time or clear what was spent — it only keeps the
        // gate out of the way while the windows go.
        let mut w = allowed("steam.exe", 2, 0);
        hold(&mut w, "steam.exe", 0, 130);
        let spent = w.spent("steam.exe");
        assert!(spent >= 120, "the allowance was not used up");

        w.close_gate();
        w.mark_closing("steam.exe", 131_000);
        w.observe(Some("steam.exe"), 132_000);

        assert!(w.spent("steam.exe") >= spent, "the grace gave time back");
        assert!(w.gated("steam.exe", 132_000), "the grace unlocked the program");
    }

    #[test]
    fn a_lapsed_grace_does_not_pile_up() {
        let mut w = watch(&["notepad.exe"]);
        w.mark_closing("notepad.exe", 1_000);
        w.observe(Some("notepad.exe"), 1_000 + CLOSE_GRACE_MS + 1);
        assert!(w.closing.is_empty(), "a lapsed grace was kept forever");
    }

    #[test]
    fn nothing_is_asked_of_a_program_with_no_name() {
        let mut w = watch(&[]);
        w.mark_closing("", 1_000);
        assert!(w.closing.is_empty(), "an empty executable was given a grace");
        assert_eq!(close_windows(""), 0);
    }

    // ---- Blocked outright ----------------------------------------------

    #[test]
    fn a_blocked_program_raises_the_gate_once() {
        let mut w = watch(&["steam.exe"]);
        assert!(w.observe(Some("steam.exe"), 1_000).raise_gate, "the gate did not go up");
        assert!(!w.observe(Some("steam.exe"), 2_000).raise_gate, "a second gate stacked on the first");
        assert_eq!(w.pending.as_ref().unwrap().exe, "steam.exe");
    }

    #[test]
    fn leaving_and_coming_back_is_a_new_decision() {
        let mut w = watch(&["steam.exe"]);
        assert!(w.observe(Some("steam.exe"), 1_000).raise_gate);
        w.close_gate();

        // Still there, and the user has just answered for it.
        assert!(!w.observe(Some("steam.exe"), 2_000).raise_gate, "the gate re-raised on a settled decision");

        assert!(!w.observe(Some("code.exe"), 3_000).raise_gate);
        assert!(w.observe(Some("steam.exe"), 4_000).raise_gate, "coming back was not asked about");
    }

    #[test]
    fn nothing_happens_to_a_program_that_is_not_blocked() {
        let mut w = watch(&["steam.exe"]);
        assert_eq!(w.observe(Some("code.exe"), 1_000), Verdict::default());
        assert!(w.pending.is_none());
    }

    #[test]
    fn a_live_unlock_lets_it_through_and_an_expired_one_does_not() {
        let mut w = watch(&["steam.exe"]);
        w.enforced.unlocked_until.insert("steam.exe".to_string(), 5_000);

        assert!(!w.observe(Some("steam.exe"), 1_000).raise_gate, "an unlock that was paid for was ignored");

        // Expiry is inclusive: at the stated millisecond the window is over.
        // And it raises the gate even with the program still in front — the
        // unlock ending is a change, like arriving.
        assert!(w.observe(Some("steam.exe"), 5_000).raise_gate, "an expired unlock kept letting it through");
    }

    #[test]
    fn an_empty_fortress_gates_nothing() {
        let mut w = WatchInner::default();
        assert_eq!(w.observe(Some("steam.exe"), 1_000), Verdict::default());
    }

    #[test]
    fn losing_the_foreground_entirely_is_not_an_event() {
        // A locked screen or a desktop switch. It must not raise a gate.
        let mut w = watch(&["steam.exe"]);
        assert!(!w.observe(None, 1_000).raise_gate);
        assert!(w.pending.is_none());
        assert!(w.observe(Some("steam.exe"), 2_000).raise_gate);
    }

    // ---- Allowances ------------------------------------------------------

    #[test]
    fn time_in_front_is_counted_and_nothing_else_is() {
        let mut w = allowed("steam.exe", 60, 5);
        hold(&mut w, "steam.exe", 0, 30);
        assert_eq!(w.spent("steam.exe"), 30);

        // Something else in front costs Steam nothing.
        hold(&mut w, "code.exe", 31_000, 30);
        assert_eq!(w.spent("steam.exe"), 31, "time behind other windows was billed");
    }

    #[test]
    fn a_sleeping_laptop_is_not_billed() {
        let mut w = allowed("steam.exe", 60, 5);
        w.observe(Some("steam.exe"), 0);
        // Eight hours later, with Steam still nominally in front.
        w.observe(Some("steam.exe"), 8 * 3600 * 1000);
        assert!(w.spent("steam.exe") <= MAX_TICK_MS / 1000, "the lid being shut was billed");
    }

    #[test]
    fn running_out_in_front_raises_the_gate_once() {
        // Two minutes, no warning. Nothing arrives — Steam is in front the whole
        // time — so the gate has to go up on the allowance running out.
        let mut w = allowed("steam.exe", 2, 0);
        let events = hold(&mut w, "steam.exe", 0, 125);

        let gates: Vec<u64> = events.iter().filter(|(_, v)| v.raise_gate).map(|(at, _)| *at).collect();
        assert_eq!(gates, vec![120_000], "the gate went up at the wrong moment, or more than once");

        // Walking away and staying in front does not raise it again.
        w.close_gate();
        let again = hold(&mut w, "steam.exe", 126_000, 10);
        assert!(again.iter().all(|(_, v)| !v.raise_gate), "a settled gate re-raised");
    }

    #[test]
    fn a_spent_allowance_gates_on_arrival() {
        let mut w = allowed("steam.exe", 1, 0);
        w.enforced.spent.insert("steam.exe".to_string(), 60);
        assert!(w.observe(Some("steam.exe"), 0).raise_gate);
    }

    #[test]
    fn the_reminder_comes_once_at_the_set_time() {
        // Three minutes, warn two before: the reminder is due one minute in.
        let mut w = allowed("steam.exe", 3, 2);
        let events = hold(&mut w, "steam.exe", 0, 179);

        let notices: Vec<(u64, u64)> = events
            .iter()
            .filter_map(|(at, v)| v.notice.as_ref().map(|n| (*at, n.remaining_secs)))
            .collect();
        assert_eq!(notices, vec![(60_000, 120)], "the reminder came at the wrong time, or twice");
    }

    #[test]
    fn a_changed_allowance_arms_the_reminder_again() {
        let mut w = allowed("steam.exe", 3, 2);
        hold(&mut w, "steam.exe", 0, 70);
        assert!(w.notice.is_some());

        // The user gives it another minute. The new limit deserves a new warning.
        w.set_enforced({
            let mut e = w.enforced.clone();
            e.allowances.insert("steam.exe".into(), Allowance { allowance_secs: 240, warn_secs: 120 });
            e.spent.insert("steam.exe".into(), 70);
            e
        });
        let events = hold(&mut w, "steam.exe", 71_000, 60);
        assert!(events.iter().any(|(_, v)| v.notice.is_some()), "a new limit came with no warning");
    }

    #[test]
    fn no_reminder_when_it_is_switched_off() {
        let mut w = allowed("steam.exe", 2, 0);
        assert!(hold(&mut w, "steam.exe", 0, 119).iter().all(|(_, v)| v.notice.is_none()));
    }

    #[test]
    fn an_unlock_holds_off_an_empty_allowance() {
        let mut w = allowed("steam.exe", 1, 0);
        w.enforced.spent.insert("steam.exe".to_string(), 60);
        w.enforced.unlocked_until.insert("steam.exe".to_string(), 10_000);
        assert!(!w.observe(Some("steam.exe"), 0).raise_gate);
        // The unlock ends with Steam still in front.
        let events = hold(&mut w, "steam.exe", 1_000, 10);
        assert_eq!(events.iter().filter(|(_, v)| v.raise_gate).count(), 1);
    }

    // ---- Handing time to the window ----------------------------------------

    #[test]
    fn taken_time_still_counts_until_the_push_that_includes_it() {
        let mut w = allowed("steam.exe", 60, 5);
        hold(&mut w, "steam.exe", 0, 40);

        let taken = w.take_usage();
        assert_eq!(taken, vec![UsageSlice { day: DAY.into(), exe: "steam.exe".into(), seconds: 40 }]);
        assert_eq!(w.spent("steam.exe"), 40, "time vanished between being taken and being pushed");

        // The window writes it and pushes the new total.
        let mut e = w.enforced.clone();
        e.spent.insert("steam.exe".into(), 40);
        w.set_enforced(e);
        assert_eq!(w.spent("steam.exe"), 40, "time was counted twice once the push arrived");
        assert!(w.take_usage().is_empty());
    }

    #[test]
    fn time_the_window_could_not_write_is_collected_again() {
        let mut w = allowed("steam.exe", 60, 5);
        hold(&mut w, "steam.exe", 0, 20);
        let taken = w.take_usage();
        w.restore_usage(taken);
        assert_eq!(w.spent("steam.exe"), 20);
        assert_eq!(w.take_usage()[0].seconds, 20);
    }

    #[test]
    fn time_keeps_the_day_it_was_counted_on() {
        let mut w = allowed("steam.exe", 60, 5);
        hold(&mut w, "steam.exe", 0, 10);

        // Midnight: the window says it is a new day, with nothing spent.
        let mut e = w.enforced.clone();
        e.day = "2026-09-18".into();
        e.spent.clear();
        w.set_enforced(e);
        assert_eq!(w.spent("steam.exe"), 0, "yesterday's time counted against today");

        // The second between the two stretches is billed when the tick at 11s
        // runs, and by then the window has named the new day — so it is the new
        // day's. Time is billed to the day it is counted on, which is also why
        // the few seconds between real midnight and the window's next push are
        // yesterday's: this side only knows the day it was told.
        hold(&mut w, "steam.exe", 11_000, 5);
        let mut taken = w.take_usage();
        taken.sort_by(|a, b| a.day.cmp(&b.day));
        assert_eq!(taken, vec![
            UsageSlice { day: DAY.into(), exe: "steam.exe".into(), seconds: 10 },
            UsageSlice { day: "2026-09-18".into(), exe: "steam.exe".into(), seconds: 6 },
        ]);
    }

    // ---- Surviving a restart -----------------------------------------------

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
        assert!(after.observe(Some("steam.exe"), 1_000).raise_gate, "a cold start let it through");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uncollected_time_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("dominus-usage-{}", std::process::id()));
        let path = dir.join("enforced.json");
        let _ = std::fs::remove_dir_all(&dir);

        let mut before = allowed("steam.exe", 60, 5);
        before.attach(path.clone());
        before.set_enforced(before.enforced.clone());
        hold(&mut before, "steam.exe", 0, 30);
        // Taken — so persisted — but the window never wrote it.
        before.take_usage();

        let mut after = WatchInner::default();
        after.attach(path.clone());
        assert_eq!(after.spent("steam.exe"), 30, "a crash lost counted time");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_from_before_allowances_still_loads() {
        let dir = std::env::temp_dir().join(format!("dominus-old-{}", std::process::id()));
        let path = dir.join("enforced.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, r#"{"blocked":["notepad.exe"],"unlocked_until":{}}"#).unwrap();

        let mut w = WatchInner::default();
        w.attach(path.clone());
        assert_eq!(w.enforced.blocked, vec!["notepad.exe".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_a_first_run_and_not_an_error() {
        let mut w = WatchInner::default();
        w.attach(std::env::temp_dir().join("dominus-watch-nothing-here/enforced.json"));
        assert!(w.enforced.blocked.is_empty());
        assert!(!w.observe(Some("steam.exe"), 1_000).raise_gate);
    }
}
