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
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};

pub const PROTOCOL: u32 = 2;
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

/// What survives a restart.
///
/// The device list has to: a pairing the app forgets when it closes would mean
/// re-entering a code on every launch, and the extension quietly losing its
/// peer in between. The fortress has to as well, or the window opens blank and
/// stays that way until the next tick a minute later.
///
/// `state_rev` is persisted with it. It is only meaningful against the state it
/// was saved beside, and restarting with a counter that began again at zero
/// would let a commit computed against the old copy land on the new one.
#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    #[serde(default)]
    devices: Vec<Device>,
    #[serde(default)]
    state: Option<Value>,
    #[serde(default)]
    state_rev: u64,
    #[serde(default)]
    device: Option<String>,
    /// Protocol 1's name for the same field. Read so a fortress that paired
    /// under Phase 1 keeps what it mirrored; never written.
    #[serde(default, skip_serializing)]
    mirrored: Option<Value>,
}

#[derive(Default)]
pub struct Inner {
    pub port: Option<u16>,
    pub devices: Vec<Device>,
    /// This app's copy of the fortress, in the shape `readPeerState()` returns.
    /// `None` until something has been synced.
    ///
    /// Deliberately a `Value` and not a typed struct: the merge rules live in
    /// Sync.js and run in the extension, so nothing on this side has any
    /// business having an opinion about what is inside. See the section on
    /// where the merge runs in ../SYNC-PROTOCOL.md.
    pub state: Option<Value>,
    /// Counts writes to `state`. Handed out with the state on `/sync` and
    /// required back on `/commit`, so a commit computed against a copy this
    /// app has since changed is refused rather than silently overwriting it.
    ///
    /// Not `fortressRev`, which counts the user's own commits and is inside
    /// the state. This counts the slot.
    pub state_rev: u64,
    /// This app's own device identity, in the same shape the extension's
    /// `ensureDevice()` mints: a UUID, stable for the life of the install.
    ///
    /// It has to be stable and it has to be persisted, because it names the
    /// weakening records this app writes — `device:rev` — and a device that
    /// changed its id would have every record it ever wrote counted as somebody
    /// else's, so no peer would ever find a holder for one.
    device: Option<String>,
    /// Where the four above are kept between runs. None before the app has
    /// told us its data directory, which is only the case in tests.
    store: Option<PathBuf>,
    code: Option<PairingCode>,
    attempts: Vec<u64>,
}

pub type Shared = Arc<Mutex<Inner>>;

impl Inner {
    /// Points the state at a file and loads whatever is already there.
    ///
    /// A missing or unreadable file is not an error: it is what a first run
    /// looks like, and it is also the safest reading of a corrupted one — an
    /// app that starts unpaired asks for a code, which is recoverable, where
    /// one that starts with half a device list is not.
    pub fn attach(&mut self, path: PathBuf) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(saved) = serde_json::from_str::<Persisted>(&text) {
                self.devices = saved.devices;
                // `mirrored` is what Phase 1 called this. A fortress that
                // paired under protocol 1 keeps what it had rather than opening
                // blank and waiting a minute for the first tick.
                self.state = saved.state.or(saved.mirrored);
                self.state_rev = saved.state_rev;
                self.device = saved.device;
            }
        }
        self.store = Some(path);
    }

    /// Writes the device list, the fortress and its revision out.
    ///
    /// Through a temporary file and a rename, because the alternative is
    /// truncating the real one and being interrupted — and a half-written
    /// device list is a fortress that cannot talk to its browser.
    fn persist(&self) {
        let Some(path) = &self.store else { return };

        let snapshot = Persisted {
            devices: self.devices.clone(),
            state: self.state.clone(),
            state_rev: self.state_rev,
            device: self.device.clone(),
            mirrored: None,
        };

        let Ok(text) = serde_json::to_string(&snapshot) else { return };

        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let temp = path.with_extension("tmp");
        if std::fs::write(&temp, text).is_ok() {
            let _ = std::fs::rename(&temp, path);
        }
    }

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
        self.persist();
        Some(token)
    }

    fn device_for_token(&mut self, token: &str) -> Option<&mut Device> {
        self.devices.iter_mut().find(|d| d.token == token)
    }

    /// This app's device id, minted on first use.
    pub fn device_id(&mut self) -> String {
        if let Some(id) = &self.device {
            return id.clone();
        }

        // A v4 UUID, laid out by hand rather than pulling a crate in for one
        // string. The extension's ensureDevice() uses crypto.randomUUID(); the
        // only thing that matters here is that the two never collide, and 122
        // random bits sees to that.
        let mut bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;

        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let id = format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]
        );

        self.device = Some(id.clone());
        self.persist();
        id
    }

    /// Replaces this app's copy and raises its revision. The only way `state`
    /// is ever written — from `/commit`, and from the window when the user
    /// edits something here.
    pub fn put_state(&mut self, state: Value) -> u64 {
        self.state = Some(state);
        self.state_rev = self.state_rev.saturating_add(1);
        self.persist();
        self.state_rev
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
    // Parsed and dropped. The extractor still earns its keep: `application/json`
    // is not a CORS-simple content type, so a body that is not JSON is refused
    // with 415 before this function is reached — which closes the preflight-free
    // path a web page could otherwise post through.
    Json(_incoming): Json<Value>,
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
    guard.persist();

    // What the extension sent is deliberately NOT stored. Protocol 1 took what the extension sent as the
    // app's own copy, which was fine while nothing here could edit anything —
    // now it would throw away an edit made in this window between the moment
    // the extension read its own state and the moment it commits the merge.
    //
    // It is one half of a merge. The result comes back on /commit, and that is
    // what is written.
    let state_rev = guard.state_rev;
    let state = guard.state.clone();

    (
        StatusCode::OK,
        Json(json!({
            "protocol": PROTOCOL,
            "stateRev": state_rev,
            // null on an app that has never held a state. The extension reads
            // that as nothing to merge and simply commits its own.
            "state": state,
        })),
    )
}

#[derive(Deserialize)]
struct CommitRequest {
    #[serde(rename = "stateRev")]
    state_rev: u64,
    state: Value,
}

/// Takes the merged result and stores it, if this app's copy has not moved
/// since it was handed out.
///
/// The merge itself runs in the extension — see the section on where the merge
/// runs in ../SYNC-PROTOCOL.md. Six hundred lines of merge rules written a
/// second time in Rust and kept in step by hand is the failure Tokens.css is
/// copied at build time to avoid, on a file where the cost of drift is a wrong
/// colour rather than a defence that quietly stopped being enforced.
async fn commit(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<CommitRequest>,
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
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unpaired" })));
    }

    // The window edited something while the merge was being computed, so the
    // merge did not see it. Refusing costs a tick; accepting would silently
    // undo whatever the user just did in this window.
    if body.state_rev != guard.state_rev {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "stale", "stateRev": guard.state_rev })),
        );
    }

    // Set before the write, so the persist inside put_state carries it out
    // rather than leaving it to be lost on the next restart.
    if let Some(device) = guard.device_for_token(&token) {
        device.last_seen = Some(now_ms());
    }

    let next = guard.put_state(body.state);

    (StatusCode::OK, Json(json!({ "stateRev": next })))
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
        .route("/dominus/v1/commit", post(commit))
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

// ---- Tests ----------------------------------------------------------------
//
//     cargo test --lib service
//
// Against the real router, through `oneshot`, so what is exercised is the thing
// that is served rather than a model of it. The four cases that matter are the
// ones where getting it wrong loses a user's edit or lets a web page in:
// an unpaired request, a stale commit, a commit that lands, and a body that
// never should have reached a handler.

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn shared() -> Shared {
        Arc::new(Mutex::new(Inner::default()))
    }

    async fn call(state: &Shared, request: Request<Body>) -> (StatusCode, Value) {
        let response = router(state.clone())
            .oneshot(request)
            .await
            .expect("the router refused to answer");

        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);

        (status, body)
    }

    fn post(path: &str, token: Option<&str>, body: Value) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(format!("/dominus/v1/{path}"))
            .header("content-type", "application/json");

        if let Some(token) = token {
            builder = builder.header("x-dominus-token", token);
        }

        builder.body(Body::from(body.to_string())).unwrap()
    }

    /// Pairs a device the way the extension does, and returns its token.
    async fn paired(state: &Shared) -> String {
        let code = state.lock().unwrap().issue_code().code;

        let (status, body) = call(
            state,
            post("pair", None, json!({ "code": code, "device": "chrome", "name": "Chrome" })),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "pairing with a live code was refused");
        body["token"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn hello_carries_the_signature_the_probe_matches_on() {
        let state = shared();
        let request = Request::builder()
            .uri("/dominus/v1/hello")
            .body(Body::empty())
            .unwrap();

        let (status, body) = call(&state, request).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["app"], "dominus");
        assert_eq!(body["protocol"], PROTOCOL);
        assert_eq!(body["paired"], false, "an unpaired app claimed to be paired");
    }

    #[tokio::test]
    async fn a_wrong_code_is_refused_and_a_used_one_cannot_be_used_twice() {
        let state = shared();
        let code = state.lock().unwrap().issue_code().code;

        let (status, _) = call(
            &state,
            post("pair", None, json!({ "code": "NOPE00", "device": "a" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a wrong code paired");

        let (status, _) = call(
            &state,
            post("pair", None, json!({ "code": code.clone(), "device": "a" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // One use. A code that survived being redeemed would be a code worth
        // watching the screen for.
        let (status, _) = call(&state, post("pair", None, json!({ "code": code, "device": "b" }))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a spent code paired a second device");
    }

    #[tokio::test]
    async fn an_unpaired_request_reaches_nothing() {
        let state = shared();

        let (status, _) = call(&state, post("sync", Some("made-up"), json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, _) = call(
            &state,
            post("commit", Some("made-up"), json!({ "stateRev": 0, "state": {} })),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        assert!(
            state.lock().unwrap().state.is_none(),
            "an unpaired request wrote to the fortress"
        );
    }

    #[tokio::test]
    async fn a_body_that_is_not_json_never_reaches_a_handler() {
        // The preflight-free path a web page could otherwise post through: a
        // "simple" request with text/plain needs no preflight, so it has to be
        // refused before any handler runs rather than after.
        let state = shared();
        let token = paired(&state).await;

        let request = Request::builder()
            .method("POST")
            .uri("/dominus/v1/commit")
            .header("content-type", "text/plain")
            .header("x-dominus-token", token)
            .body(Body::from("{\"stateRev\":0,\"state\":{}}"))
            .unwrap();

        let (status, _) = call(&state, request).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(
            state.lock().unwrap().state.is_none(),
            "a text/plain post wrote to the fortress"
        );
    }

    #[tokio::test]
    async fn a_round_trip_lands_and_comes_back() {
        let state = shared();
        let token = paired(&state).await;

        // Nothing held yet: the extension reads `state: null` as nothing to
        // merge and commits its own.
        let (status, body) = call(&state, post("sync", Some(&token), json!({ "fortressRev": 1 }))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["protocol"], PROTOCOL);
        assert_eq!(body["stateRev"], 0);
        assert_eq!(body["state"], Value::Null);

        let merged = json!({ "fortressRev": 1, "fortress": { "manualSites": ["x.com"] } });
        let (status, body) = call(
            &state,
            post("commit", Some(&token), json!({ "stateRev": 0, "state": merged })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["stateRev"], 1, "the commit did not raise the revision");

        // And the next tick reads back exactly what was committed.
        let (_, body) = call(&state, post("sync", Some(&token), json!({}))).await;
        assert_eq!(body["stateRev"], 1);
        assert_eq!(body["state"]["fortress"]["manualSites"][0], "x.com");

        // What the extension SENDS is never stored — only what it commits. The
        // sync body above was `{}`, and it must not have replaced anything.
        assert_eq!(
            state.lock().unwrap().state.as_ref().unwrap()["fortressRev"],
            1,
            "the app took what it was sent as its own copy"
        );
    }

    #[tokio::test]
    async fn an_edit_in_the_window_refuses_the_merge_that_did_not_see_it() {
        let state = shared();
        let token = paired(&state).await;

        // The extension reads the app's copy.
        let (_, body) = call(&state, post("sync", Some(&token), json!({}))).await;
        let handed_out = body["stateRev"].as_u64().unwrap();

        // The user edits a category in this window while the merge is running.
        let mine = json!({ "fortress": { "manualSites": ["edited-here.com"] } });
        state.lock().unwrap().put_state(mine);

        // The merge is now against a copy that has moved, so it is refused and
        // nothing is written. The extension loses a tick, which is a minute.
        let (status, body) = call(
            &state,
            post(
                "commit",
                Some(&token),
                json!({ "stateRev": handed_out, "state": { "fortress": { "manualSites": [] } } }),
            ),
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "stale");
        assert_eq!(body["stateRev"], 1, "the refusal did not say where to start again");

        let guard = state.lock().unwrap();
        assert_eq!(
            guard.state.as_ref().unwrap()["fortress"]["manualSites"][0],
            "edited-here.com",
            "a stale commit overwrote an edit made in the window"
        );

        // And the retry, against the revision the refusal named, lands.
        drop(guard);
        let (status, _) = call(
            &state,
            post("commit", Some(&token), json!({ "stateRev": 1, "state": { "ok": true } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "the retry was refused too");
    }

    #[tokio::test]
    async fn a_state_written_under_protocol_1_survives_the_upgrade() {
        // Phase 1 called this `mirrored`. A fortress that paired then must not
        // open blank on the first launch after upgrading.
        let dir = std::env::temp_dir().join(format!("dominus-test-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");

        std::fs::write(
            &path,
            r#"{"devices":[],"mirrored":{"fortressRev":4}}"#,
        )
        .unwrap();

        let mut inner = Inner::default();
        inner.attach(path.clone());

        assert_eq!(
            inner.state.as_ref().expect("the mirrored fortress was dropped")["fortressRev"],
            4
        );
        assert_eq!(inner.state_rev, 0);

        // And it is written back under the new name.
        inner.put_state(json!({ "fortressRev": 5 }));
        let text = std::fs::read_to_string(&path).unwrap();
        let saved: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(saved["state"]["fortressRev"], 5);
        assert_eq!(saved["state_rev"], 1);
        assert!(saved.get("mirrored").is_none(), "the old key was written back");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
