// lib.rs — the app.
//
// Phase 1: a window, a tray, one instance, and the loopback service the
// extension pairs with. Everything the window can show, it shows because the
// extension told it — see ../SYNC-PROTOCOL.md.

mod service;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
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

/// The fortress as the extension last sent it, for the views to render.
/// `None` until something has been synced.
#[tauri::command]
fn mirrored_state(state: tauri::State<Shared>) -> Option<Value> {
    state.lock().ok().and_then(|guard| guard.mirrored.clone())
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
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![
            service_status,
            new_pairing_code,
            mirrored_state
        ])
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Dominus is meant to be running whether or not its window is, so
            // the tray is how you get back to it — and closing the window will
            // eventually hide rather than quit, once there is background work
            // worth keeping alive.
            let open = MenuItem::with_id(app, "open", "Open Dominus", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Dominus")
                .menu(&menu)
                .show_menu_on_left_click(false)
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
