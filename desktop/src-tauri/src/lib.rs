// lib.rs — the app.
//
// A window, a tray, one instance, and the loopback service the extension pairs
// with — see ../SYNC-PROTOCOL.md.
//
// There are no merge rules here and no authoring rules here. Both live in
// Sync.js, which the window loads a build-time copy of, and this side holds the
// state as opaque JSON behind a revision counter. The argument for that is in
// the protocol document; the short version is that six hundred lines of merge
// rules written twice and kept in step by hand is how a defence quietly stops
// being enforced.

mod service;
mod watcher;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

use service::{PairingCode, Shared};
use watcher::{Enforced, Notice, PendingGate, UsageSlice, Watch, WatchInner, POLL_INTERVAL_MS};

#[derive(Serialize)]
struct DeviceView {
    id: String,
    name: String,
    #[serde(rename = "lastSeen")]
    last_seen: Option<u64>,
}

#[derive(Serialize)]
struct ServiceStatus {
    running: bool,
    port: Option<u16>,
    paired: bool,
    devices: Vec<DeviceView>,
}

/// What the window asks for on every visit to The Seal.
///
/// `running: false` is a real answer, not just a not-yet-implemented one —
/// every port in the range can genuinely be taken — so the window is built to
/// show it rather than to assume success.
#[tauri::command]
fn service_status(state: tauri::State<Shared>) -> ServiceStatus {
    let guard = match state.lock() {
        Ok(g) => g,
        Err(_) => {
            return ServiceStatus {
                running: false,
                port: None,
                paired: false,
                devices: vec![],
            }
        }
    };

    ServiceStatus {
        running: guard.port.is_some(),
        port: guard.port,
        paired: !guard.devices.is_empty(),
        // The token never leaves the Rust side. The window has no use for it,
        // and a secret that is not sent cannot be read out of a WebView.
        devices: guard
            .devices
            .iter()
            .map(|d| DeviceView {
                id: d.id.clone(),
                name: d.name.clone(),
                last_seen: d.last_seen,
            })
            .collect(),
    }
}

#[tauri::command]
fn new_pairing_code(state: tauri::State<Shared>) -> Option<PairingCode> {
    state.lock().ok().map(|mut guard| guard.issue_code())
}

/// This app's copy of the fortress, for the views to render and edit.
/// `None` until something has been synced.
#[derive(Serialize)]
struct PeerState {
    #[serde(rename = "stateRev")]
    state_rev: u64,
    state: Option<Value>,
    /// This app's own device id. The window needs it to name the weakening
    /// records it writes — see the note on `Inner::device_id`.
    device: String,
}

#[tauri::command]
fn peer_state(state: tauri::State<Shared>) -> PeerState {
    match state.lock() {
        Ok(mut guard) => PeerState {
            state_rev: guard.state_rev,
            state: guard.state.clone(),
            device: guard.device_id(),
        },
        Err(_) => PeerState { state_rev: 0, state: None, device: String::new() },
    }
}

/// Writes an edit made in this window.
///
/// The window has already worked out what the edit gave up and stamped the
/// record for it, using the same Sync.js the extension runs — so what arrives
/// here is a finished state and this function's whole job is to store it and
/// raise the revision. Raising it is what makes a merge that was computed
/// against the previous copy fail its compare-and-set on /commit rather than
/// silently undoing what the user just did.
///
/// `expectedRev` is the revision the window read before editing. A mismatch
/// means a sync landed underneath the edit, and the window is told to re-read
/// rather than write over it.
#[tauri::command]
fn put_state(
    state: tauri::State<Shared>,
    expected_rev: Option<u64>,
    next: Value,
) -> Result<u64, String> {
    let mut guard = state.lock().map_err(|_| "busy".to_string())?;

    if let Some(expected) = expected_rev {
        if expected != guard.state_rev {
            return Err("stale".to_string());
        }
    }

    Ok(guard.put_state(next))
}

/// What the window tells this side to enforce.
///
/// Called on every state change: after a sync, after an edit here, and after an
/// unlock. It is a list of executables and a map of expiries — see
/// `watcher::Enforced`, and ../APP-LIMITS.md for why it is that and nothing more.
#[tauri::command]
fn set_enforced(watch: tauri::State<Watch>, enforced: Enforced) {
    if let Ok(mut guard) = watch.lock() {
        guard.set_enforced(enforced);
    }
}

/// The programs the picker can offer. Enumerated on request rather than kept
/// up to date, because nothing needs it except a person looking at the list.
#[tauri::command]
fn running_applications() -> Vec<watcher::RunningApplication> {
    watcher::running_applications()
}

/// What the gate is currently standing in front of, if anything.
///
/// The gate window asks for this on load rather than being handed it, because a
/// window that has just been shown may have been shown before and may still be
/// holding the last thing it was told.
#[tauri::command]
fn pending_gate(watch: tauri::State<Watch>) -> Option<PendingGate> {
    watch.lock().ok().and_then(|guard| guard.pending.clone())
}

/// The user has answered, whichever way. Rust is not told which — recording is
/// the window's job, and this side has no business knowing whether a stand or
/// an unlock just happened.
#[tauri::command]
fn close_gate(app: tauri::AppHandle, watch: tauri::State<Watch>) {
    if let Ok(mut guard) = watch.lock() {
        guard.close_gate();
    }
    if let Some(gate) = app.get_webview_window("gate") {
        let _ = gate.hide();
    }
}

/// Everything counted since the window last asked, for it to write into the
/// day's usage event. Rust never writes a record; see "Spending" in
/// ../APP-LIMITS.md.
#[tauri::command]
fn take_usage(watch: tauri::State<Watch>) -> Vec<UsageSlice> {
    watch.lock().map(|mut guard| guard.take_usage()).unwrap_or_default()
}

/// The window took time and could not write it. Counted again next time.
#[tauri::command]
fn restore_usage(watch: tauri::State<Watch>, slices: Vec<UsageSlice>) {
    if let Ok(mut guard) = watch.lock() {
        guard.restore_usage(slices);
    }
}

/// Seconds spent today by every program with an allowance, including time the
/// window has not collected yet — what The Fortress shows as "used today".
#[tauri::command]
fn usage_today(watch: tauri::State<Watch>) -> std::collections::HashMap<String, u64> {
    watch.lock().map(|guard| guard.spent_today()).unwrap_or_default()
}

/// The reminder currently showing, for the reminder window to read on load.
#[tauri::command]
fn pending_notice(watch: tauri::State<Watch>) -> Option<Notice> {
    watch.lock().ok().and_then(|guard| guard.notice.clone())
}

#[tauri::command]
fn close_notice(app: tauri::AppHandle, watch: tauri::State<Watch>) {
    if let Ok(mut guard) = watch.lock() {
        guard.close_notice();
    }
    if let Some(window) = app.get_webview_window("notice") {
        let _ = window.hide();
    }
}

/// Shows the reminder in the corner without taking focus from what the user
/// is doing — see `watcher::show_without_focus`.
fn raise_notice(app: &tauri::AppHandle, notice: &Notice) {
    let Some(window) = app.get_webview_window("notice") else {
        return;
    };

    let _ = app.emit("notice-raised", notice.clone());

    // Bottom right of the monitor the user is on, clear of the taskbar.
    if let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) {
        let area = monitor.work_area();
        if let Ok(size) = window.outer_size() {
            let margin = (16.0 * monitor.scale_factor()) as i32;
            let x = area.position.x + area.size.width as i32 - size.width as i32 - margin;
            let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }

    // Shown through Tauri, so the webview knows it is on screen and draws —
    // the window is built unfocusable, which is what keeps this from taking
    // the keyboard. Then pinned topmost without activation, as a second line.
    let _ = window.show();

    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            watcher::show_without_focus(hwnd.0 as isize);
        }
    }
}

fn hide_notice(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("notice") {
        let _ = window.hide();
    }
}

fn raise_gate(app: &tauri::AppHandle, pending: &PendingGate) {
    let Some(gate) = app.get_webview_window("gate") else {
        return;
    };

    // The event first, so the window has the answer before it is looked at.
    // It also asks for itself on load, which covers the first raise, when the
    // webview may not have a listener attached yet.
    let _ = app.emit("gate-raised", pending.clone());
    let _ = gate.show();
    let _ = gate.set_focus();
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared: Shared = Arc::new(Mutex::new(service::Inner::default()));
    let watch: Watch = Arc::new(Mutex::new(WatchInner::default()));

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // A second launch raises the window that is already open rather than
        // starting a rival copy — two Dominus processes would mean two
        // services fighting over the port range and two views of one fortress.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }));

        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    builder
        // Closing the window hides it instead of quitting. Dominus is meant to
        // be running whether or not you are looking at it — the loopback
        // service the extension pairs with lives in this process, and Tauri's
        // default of exiting with the last window took it down with the window.
        // Quit is the tray's job, where it is a decision rather than a reflex.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .manage(shared.clone())
        .manage(watch.clone())
        .invoke_handler(tauri::generate_handler![
            service_status,
            new_pairing_code,
            set_enforced,
            running_applications,
            take_usage,
            restore_usage,
            usage_today,
            pending_notice,
            close_notice,
            pending_gate,
            close_gate,
            peer_state,
            put_state
        ])
        .setup(move |app| {
            // Load the device list and the fortress before anything can ask
            // for them, so a restart is invisible to the extension.
            if let Ok(dir) = app.path().app_data_dir() {
                if let Ok(mut guard) = shared.lock() {
                    guard.attach(dir.join("state.json"));
                }
                // Its own file, not a corner of state.json. What to enforce is
                // a cache of what the window last said; the state is the
                // fortress itself. Keeping them apart is what stops this side
                // being tempted to derive one from the other.
                if let Ok(mut guard) = watch.lock() {
                    guard.attach(dir.join("enforced.json"));
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Dominus is meant to be running whether or not its window is, so
            // the tray is how you get back to it once the window is closed —
            // and the only place Quit lives, because quitting takes the sync
            // service down and that should be a decision, not a stray click.
            let open = MenuItem::with_id(app, "open", "Open Dominus", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Dominus")
                .menu(&menu)
                // Left click raises the window, right click opens the menu —
                // the habit everything else in the Windows tray has taught.
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Built once, hidden, and shown when something needs stopping.
            // Creating it on demand would put the cost of a webview start
            // between clicking a blocked program and being told — which is the
            // moment the gate has to be immediate to mean anything.
            let gate = WebviewWindowBuilder::new(app, "gate", WebviewUrl::App("gate.html".into()))
                .title("Dominus")
                // Sized so the tallest ordinary state — a twelve-word passage
                // over three lines, with its box and its buttons — fits without
                // scrolling. A reflection message can be any length the user
                // typed, and that one does scroll.
                .inner_size(560.0, 680.0)
                .resizable(false)
                .center()
                .always_on_top(true)
                // Not in the taskbar and not decorated: this is an
                // interruption, not a document. It is still ordinary enough to
                // alt-tab away from, which is deliberate — the program stays
                // minimized because nothing un-minimized it, and Dominus has
                // never trapped anyone anywhere.
                .skip_taskbar(true)
                .decorations(false)
                .visible(false)
                .build()?;

            // Closing the gate is answering it: the same as walking away, and
            // the window records the stand before it asks for this.
            let closing = app.handle().clone();
            gate.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(window) = closing.get_webview_window("gate") {
                        let _ = window.hide();
                    }
                }
            });

            // The allowance reminder: small, in the corner, never focused, and
            // never in the taskbar. Built once and hidden, like the gate.
            let notice = WebviewWindowBuilder::new(app, "notice", WebviewUrl::App("notice.html".into()))
                .title("Dominus")
                .inner_size(360.0, 124.0)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .decorations(false)
                // Never the active window: WS_EX_NOACTIVATE, so neither showing
                // it nor clicking it takes the keyboard from what the user is
                // doing. The dismiss button still works — clicks reach a
                // window that is not activated.
                .focusable(false)
                .focused(false)
                .visible(false)
                .build()?;

            let dismissing = app.handle().clone();
            notice.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    hide_notice(&dismissing);
                }
            });

            // The watch itself. A thread rather than an async task because it
            // is a blocking Win32 call on a fixed cadence with nothing to await
            // — and because it must keep its rhythm whatever the async runtime
            // is doing about the HTTP service.
            let ticking = watch.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));

                let seen = watcher::foreground();
                let now = service::now_ms();

                let (gate, notice) = match ticking.lock() {
                    Ok(mut guard) => {
                        let exe = seen.as_ref().map(|(name, _)| name.as_str());
                        let verdict = guard.observe(exe, now);
                        let gate = if verdict.raise_gate { guard.pending.clone() } else { None };
                        (gate, verdict.notice)
                    }
                    // A poisoned lock means another thread panicked while
                    // holding it. Enforcing nothing is the safe reading: the
                    // alternative is a gate raised against a list nobody can
                    // vouch for.
                    Err(_) => (None, None),
                };

                if let Some(pending) = gate {
                    // Minimize first. The gate appearing over a program that is
                    // still there reads as a suggestion; the program going away
                    // is what makes it a decision.
                    if let Some((_, hwnd)) = seen {
                        watcher::minimize(hwnd);
                    }
                    hide_notice(&handle);
                    raise_gate(&handle, &pending);
                } else if let Some(notice) = notice {
                    raise_notice(&handle, &notice);
                }
            });

            let state = shared.clone();
            tauri::async_runtime::spawn(async move {
                match service::start(state).await {
                    Some(port) => log::info!("loopback service listening on 127.0.0.1:{port}"),
                    // Not fatal. The window says so plainly, and the extension
                    // simply finds nothing when it probes — it holds its own
                    // enforceable copy of every rule and never waits on us.
                    None => log::error!(
                        "no free port in {:?}; the extension will not find this app",
                        service::PORT_RANGE
                    ),
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
