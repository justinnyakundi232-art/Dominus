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

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

use service::{PairingCode, Shared};

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
        .invoke_handler(tauri::generate_handler![
            service_status,
            new_pairing_code,
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
