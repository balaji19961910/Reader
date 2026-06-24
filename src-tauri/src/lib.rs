use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
// Emitter/Manager are only used by the macOS/iOS-gated file-open + media-key code.
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::{Emitter, Manager};

// Queue of files the OS asked us to open (file associations / "Open with").
#[derive(Default)]
struct Pending(Mutex<Vec<String>>);

// Whether the macOS media-key (◀◀/▶▶) monitor should page (toggleable from JS).
struct MediaFlag(Arc<AtomicBool>);

#[tauri::command]
fn set_media_keys(state: tauri::State<MediaFlag>, on: bool) {
    state.0.store(on, Ordering::Relaxed);
}

// Drain and return any files queued for opening (desktop launch-with-file).
#[tauri::command]
fn get_pending_files(state: tauri::State<Pending>) -> Vec<String> {
    let mut q = state.0.lock().unwrap();
    std::mem::take(&mut *q)
}

// Read a file's raw bytes — returned to the webview as an ArrayBuffer.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

// Keep the window pinned above all other apps (or release it).
// `set_always_on_top` only exists on desktop; no-op on mobile.
#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, on: bool) {
    #[cfg(desktop)]
    {
        let _ = window.set_always_on_top(on);
    }
    #[cfg(not(desktop))]
    {
        let _ = (window, on);
    }
}

// Set the true native window opacity (0.1–1.0). macOS uses NSWindow alphaValue,
// which makes the whole window — chrome included — translucent like a PiP player.
#[tauri::command]
fn set_window_opacity(window: tauri::WebviewWindow, opacity: f64) {
    let clamped = opacity.clamp(0.1, 1.0);
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        if let Ok(ptr) = window.ns_window() {
            let ns: *mut Object = ptr as *mut Object;
            unsafe {
                let _: () = msg_send![ns, setAlphaValue: clamped];
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, clamped);
    }
}

// macOS: capture the hardware media keys (◀◀ rewind = prev, ▶▶ fast = next),
// even without `fn`. Uses a local NSEvent monitor for system-defined events,
// active while the app is focused.
#[cfg(target_os = "macos")]
fn setup_media_keys(app: tauri::AppHandle, enabled: Arc<AtomicBool>) {
    use block::ConcreteBlock;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    type Id = *mut Object;
    let mask: u64 = 1 << 14; // NSEventMaskSystemDefined (NSSystemDefined = 14)

    let block = ConcreteBlock::new(move |event: Id| -> Id {
        if !enabled.load(Ordering::Relaxed) {
            return event;
        }
        unsafe {
            let subtype: std::os::raw::c_short = msg_send![event, subtype];
            if subtype == 8 {
                // NX_SUBTYPE_AUX_CONTROL_BUTTONS
                let data1: i64 = msg_send![event, data1];
                let key_code = ((data1 & 0xFFFF_0000) >> 16) as i32;
                let key_down = ((data1 & 0x0000_FF00) >> 8) == 0x0A;
                if key_down {
                    let dir = match key_code {
                        20 => Some("prev"), // NX_KEYTYPE_REWIND
                        19 => Some("next"), // NX_KEYTYPE_FAST
                        _ => None,
                    };
                    if let Some(d) = dir {
                        let _ = app.emit("media-key", d);
                        return std::ptr::null_mut(); // consume
                    }
                }
            }
        }
        event
    });
    let block = block.copy();
    unsafe {
        let cls = class!(NSEvent);
        let _monitor: Id =
            msg_send![cls, addLocalMonitorForEventsMatchingMask: mask handler: &*block];
        let _ = _monitor;
    }
    std::mem::forget(block); // keep the handler alive for the app's lifetime
}

// --- OAuth (Google Drive sign-in on desktop) -----------------------------
// Desktop uses the standard installed-app flow: open the system browser to the
// consent page with a 127.0.0.1 loopback redirect, capture the code, and
// exchange it (with the desktop client secret + PKCE verifier) for tokens.
#[derive(serde::Serialize)]
struct OauthTokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

#[cfg(desktop)]
fn parse_query_param(req: &str, key: &str) -> Option<String> {
    let line = req.lines().next()?; // GET /?code=XXX&... HTTP/1.1
    let path = line.split_whitespace().nth(1)?;
    let q = path.split('?').nth(1)?;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next()? == key {
            let val = it.next().unwrap_or("");
            return Some(
                urlencoding::decode(val)
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| val.to_string()),
            );
        }
    }
    None
}

#[cfg(desktop)]
fn token_request(token_url: &str, form: &[(&str, &str)]) -> Result<OauthTokens, String> {
    let resp = ureq::post(token_url)
        .send_form(form)
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(format!(
            "{}: {}",
            err,
            json.get("error_description").and_then(|v| v.as_str()).unwrap_or("")
        ));
    }
    Ok(OauthTokens {
        access_token: json["access_token"].as_str().unwrap_or("").to_string(),
        refresh_token: json["refresh_token"].as_str().map(|s| s.to_string()),
        expires_in: json["expires_in"].as_i64().unwrap_or(3600),
    })
}

#[cfg(desktop)]
fn desktop_oauth_blocking(
    client_id: String,
    client_secret: String,
    scope: String,
    challenge: String,
    verifier: String,
    auth_base: String,
    token_url: String,
) -> Result<OauthTokens, String> {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let enc = |s: &str| urlencoding::encode(s).into_owned();
    let auth_url = format!(
        "{auth_base}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        enc(&client_id), enc(&redirect), enc(&scope), enc(&challenge),
    );
    open::that(&auth_url).map_err(|e| e.to_string())?;

    let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let code = parse_query_param(&req, "code");
    let body = "<html><body style='font-family:system-ui;text-align:center;padding-top:3rem'><h2>Reader is connected ✓</h2><p>You can close this tab and return to the app.</p></body></html>";
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(), body,
    );
    let _ = stream.write_all(resp.as_bytes());

    let code = code.ok_or("No authorization code was returned")?;
    token_request(
        &token_url,
        &[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect.as_str()),
        ],
    )
}

// Open the browser, run the loopback, return tokens. Desktop only.
#[tauri::command]
async fn desktop_oauth(
    client_id: String,
    client_secret: String,
    scope: String,
    challenge: String,
    verifier: String,
    auth_base: String,
    token_url: String,
) -> Result<OauthTokens, String> {
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            desktop_oauth_blocking(
                client_id, client_secret, scope, challenge, verifier, auth_base, token_url,
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(desktop))]
    {
        let _ = (client_id, client_secret, scope, challenge, verifier, auth_base, token_url);
        Err("desktop only".into())
    }
}

// Exchange a refresh token for a fresh access token. Desktop only.
#[tauri::command]
async fn oauth_refresh(
    client_id: String,
    client_secret: String,
    refresh_token: String,
    token_url: String,
) -> Result<OauthTokens, String> {
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            token_request(
                &token_url,
                &[
                    ("client_id", client_id.as_str()),
                    ("client_secret", client_secret.as_str()),
                    ("refresh_token", refresh_token.as_str()),
                    ("grant_type", "refresh_token"),
                ],
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(desktop))]
    {
        let _ = (client_id, client_secret, refresh_token, token_url);
        Err("desktop only".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // On Windows/Linux a file opened via "Open with" arrives as a CLI argument.
    let initial: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-') && std::path::Path::new(a).exists())
        .collect();

    let media_enabled = Arc::new(AtomicBool::new(true));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Pending(Mutex::new(initial)))
        .manage(MediaFlag(media_enabled.clone()))
        .setup(move |_app| {
            #[cfg(target_os = "macos")]
            setup_media_keys(_app.handle().clone(), media_enabled.clone());
            let _ = &media_enabled;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_always_on_top,
            set_window_opacity,
            get_pending_files,
            read_file_bytes,
            set_media_keys,
            desktop_oauth,
            oauth_refresh
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            // macOS/iOS deliver files opened via "Open with" as a RunEvent.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if let Some(state) = _app.try_state::<Pending>() {
                    state.0.lock().unwrap().extend(paths.clone());
                }
                let _ = _app.emit("open-file", paths);
            }
        });
}
