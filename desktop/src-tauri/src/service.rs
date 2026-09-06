// service.rs — the loopback service the extension talks to.
//
// The full reasoning lives in ../SYNC-PROTOCOL.md; this implements it. The
// short version:
//
//   - HTTP on 127.0.0.1, because Chrome spawns a native messaging host as a
//     child process (so this long-lived app cannot be one) and MV3 kills the
//     service worker after ~30s idle (so it cannot hold a socket open).
//   - The port is the first free one in 47823..=47832. The extension probes
//     the range and caches whatever answers `/hello` with our signature.
//   - A six-character code, shown in this app's window and typed into the
//     extension, is exchanged once for a long-lived device token. That is what
//     another program listening on the same port range cannot fake: it does
//     not know the code, because the code is only on this app's screen.
//   - Every other request carries `X-Dominus-Token`. A custom header forces a
//     CORS preflight, which is what keeps web pages out — CORS stops a page
//     reading a response, but a simple POST still arrives and is still
//     processed, and reading nothing back is no comfort when the damage is a
//     write.

use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};

pub const PROTOCOL: u32 = 1;
pub const PORT_RANGE: std::ops::RangeInclusive<u16> = 47823..=47832;

/// A pairing code is worth something only while it is on screen. Five minutes
/// is long enough to walk to the browser and type six characters, short enough
/// that a code left visible on an unattended screen stops mattering.
const CODE_TTL_MS: u64 = 5 * 60 * 1000;

/// Six characters from a 32-symbol alphabet is ~30 bits. That is not a secret
/// worth attacking offline, and it does not need to be — it can only be used
/// against a running service, over loopback, five times a minute, once.
const MAX_CODE_ATTEMPTS: u32 = 5;
const ATTEMPT_WINDOW_MS: u64 = 60 * 1000;

/// No I, O, 0 or 1: the code is read off a screen and typed by a person, and
/// the characters that get confused are worth more than the entropy they add.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub token: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
}

#[derive(Clone, Serialize)]
pub struct PairingCode {
    pub code: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

#[derive(Default)]
pub struct Inner {
    pub port: Option<u16>,
    pub devices: Vec<Device>,
    /// The fortress as the extension last sent it. Phase 1 stores and displays
    /// it; nothing here writes back yet, so nothing this app does can weaken a
    /// fortress while the merge is still unproven in the field.
    pub mirrored: Option<Value>,
    code: Option<PairingCode>,
    attempts: Vec<u64>,
}

pub type Shared = Arc<Mutex<Inner>>;

impl Inner {
    /// Issues a fresh code, discarding any previous one. Called when the
    /// pairing panel is opened and when the user asks for a new one — a code
    /// that has quietly expired is worse than no code, because the user types
    /// it, is refused, and has no idea why.
    pub fn issue_code(&mut self) -> PairingCode {
        let mut rng = rand::rng();
        let code: String = (0..6)
            .map(|_| CODE_ALPHABET[rng.random_range(0..CODE_ALPHABET.len())] as char)
            .collect();

        let issued = PairingCode {
            code,
            expires_at: now_ms() + CODE_TTL_MS,
        };

        self.code = Some(issued.clone());
        self.attempts.clear();
        issued
    }

    fn throttled(&mut self) -> bool {
        let cutoff = now_ms().saturating_sub(ATTEMPT_WINDOW_MS);
        self.attempts.retain(|at| *at >= cutoff);
        self.attempts.len() as u32 >= MAX_CODE_ATTEMPTS
    }

    /// Consumes the code if it matches and is live. Returns the new token.
    ///
    /// The code is discarded on success AND after too many failures: a code
    /// that survived guessing would be worth guessing at.
    fn redeem(&mut self, offered: &str, device_id: &str, name: &str) -> Option<String> {
        if self.throttled() {
            self.code = None;
            return None;
        }

        let live = match &self.code {
            Some(c) if c.expires_at > now_ms() => c.clone(),
            _ => {
                self.attempts.push(now_ms());
                return None;
            }
        };

        if !live.code.eq_ignore_ascii_case(offered.trim()) {
            self.attempts.push(now_ms());
            return None;
        }

        let token: String = {
            let mut rng = rand::rng();
            (0..32)
                .map(|_| format!("{:02x}", rng.random::<u8>()))
                .collect()
        };

        // Re-pairing a device it already knows replaces that entry rather than
        // adding a second one, so the device list stays a list of devices
        // rather than a list of pairings.
        self.devices.retain(|d| d.id != device_id);
        self.devices.push(Device {
            id: device_id.to_string(),
            name: name.to_string(),
            token: token.clone(),
            paired_at: now_ms(),
            last_seen: None,
        });

        self.code = None;
        self.attempts.clear();
        Some(token)
    }

    fn device_for_token(&mut self, token: &str) -> Option<&mut Device> {
        self.devices.iter_mut().find(|d| d.token == token)
    }
}

// ---- Handlers -------------------------------------------------------------

async fn hello(State(state): State<Shared>) -> Json<Value> {
    let paired = state.lock().map(|s| !s.devices.is_empty()).unwrap_or(false);
    Json(json!({
        // The signature the extension's port probe matches on. Something else
        // holding this port will not answer with it.
        "app": "dominus",
        "protocol": PROTOCOL,
        "version": env!("CARGO_PKG_VERSION"),
        "paired": paired,
    }))
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    device: String,
    #[serde(default)]
    name: Option<String>,
}

async fn pair(
    State(state): State<Shared>,
    Json(body): Json<PairRequest>,
) -> (StatusCode, Json<Value>) {
    let name = body.name.unwrap_or_else(|| "Chrome extension".to_string());
    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"busy"}))),
    };

    match guard.redeem(&body.code, &body.device, &name) {
        Some(token) => (StatusCode::OK, Json(json!({ "token": token }))),
        // One message for wrong, expired, used and throttled alike. Telling a
        // guesser which of those it was is telling it how to guess better.
        None => (StatusCode::FORBIDDEN, Json(json!({ "error": "bad-code" }))),
    }
}

async fn sync(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let token = headers
        .get("x-dominus-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"busy"}))),
    };

    if guard.device_for_token(&token).is_none() {
        // The extension clears its token on this and stops sending until the
        // user pairs again, rather than retrying a credential that is gone.
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unpaired" })));
    }

    if let Some(device) = guard.device_for_token(&token) {
        device.last_seen = Some(now_ms());
    }

    guard.mirrored = Some(body);

    // Phase 1 is read-only in the app's favour: it takes what the extension
    // sends and returns nothing to merge. Sending state back waits until the
    // merge rules have been exercised against a real second peer.
    (StatusCode::OK, Json(json!({ "accepted": true, "protocol": PROTOCOL })))
}

// ---- Wiring ---------------------------------------------------------------

fn router(state: Shared) -> Router {
    // Only extension origins get a preflight answered. A web page's origin is
    // http(s):// and never matches, so its request never reaches a handler —
    // which is the point, since CORS alone would let the write land and only
    // hide the response.
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin
                .to_str()
                .map(|o| o.starts_with("chrome-extension://"))
                .unwrap_or(false)
        }))
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderName::from_static("x-dominus-token"),
        ]);

    Router::new()
        .route("/dominus/v1/hello", get(hello))
        .route("/dominus/v1/pair", post(pair))
        .route("/dominus/v1/sync", post(sync))
        .layer(cors)
        .with_state(state)
}

/// Binds the first free port in the range and serves until the app exits.
///
/// Returns the port it took, or None if every port in the range was busy —
/// which is a real state the window has to show, not an impossible one.
pub async fn start(state: Shared) -> Option<u16> {
    for port in PORT_RANGE {
        // Loopback only, never 0.0.0.0: nothing on the network can reach this,
        // only this machine.
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(_) => continue,
        };

        if let Ok(mut guard) = state.lock() {
            guard.port = Some(port);
        }

        let app = router(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        return Some(port);
    }

    None
}
