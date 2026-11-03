//! promptgraph desktop shell (DESIGN §20): one window around the web UI served by the Node daemon, which it
//! reaches only through the CLI. No logic beyond the window, the CLI call, the allowed origin, the runtime
//! capability, the guards, splash errors and `relogin`; `packages/desktop/test/contract.test.ts` checks it as text.

use std::{collections::HashSet, ffi::OsString, io::Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

/// `promptgraph open --print-url --json` (DESKTOP_OPEN_ARGS in packages/shared/src/desktop.ts).
const OPEN_ARGS: [&str; 3] = ["open", "--print-url", "--json"];
/// Removed from the CLI's environment (DESKTOP_STRIPPED_ENV / DESKTOP_STRIPPED_ENV_PREFIXES).
const STRIPPED_ENV: [&str; 6] = ["LD_LIBRARY_PATH", "LD_PRELOAD", "APPDIR", "APPIMAGE", "ARGV0", "OWD"];
const STRIPPED_ENV_PREFIXES: [&str; 5] = ["GTK_", "GDK_", "GIO_", "GSETTINGS_", "WEBKIT_"];
/// Granted to the daemon's origin (DESKTOP_PERMISSIONS); the opener one is added scoped to https.
const PERMISSIONS: [&str; 9] = [
    "core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-internal-toggle-maximize",
    "core:window:allow-is-maximized", "core:window:allow-close", "core:window:allow-start-dragging",
    "core:window:allow-start-resize-dragging", "core:window:allow-set-title", "allow-relogin",
];
const OPENER_PERMISSION: &str = "opener:allow-open-url";
const CLI_TIMEOUT: Duration = Duration::from_secs(30);
/// Execs the CLI with the shell's remaining arguments (`$0` is the binary).
const POSIX_EXEC: &str = r#"exec "$0" "$@""#;
const NOT_FOUND: &str = "promptgraph CLI not found: install it with `npm i -g promptgraph` or set `PROMPTGRAPH_BIN`";

/// The fields of OpenUrlResult the shell needs (OpenUrlResultSchema; `v` is checked first).
#[derive(Deserialize)]
struct OpenUrlResult {
    url: String,
    port: u16,
}

struct Shared {
    /// The daemon origin the window may show; updated by every successful CLI call.
    origin: Mutex<Option<String>>,
    /// The splash may be shown only while the shell itself shows it (start, retry, error).
    showing_splash: AtomicBool,
    granted: Mutex<HashSet<String>>, // origins that have a runtime capability (it cannot be removed)
    cli: Mutex<()>,                  // one CLI call at a time
    repo: Option<String>,
    custom: bool, // the page draws the title bar (PG_DESKTOP_DECORATIONS); the splash keeps the native frame
    dev_origin: Option<String>, // `tauri dev` serves the splash from its dev server instead of `tauri://`
}

fn version_required() -> String {
    format!("promptgraph ≥ {} is required", env!("CARGO_PKG_VERSION"))
}

/// Copies a pipe into a buffer on its own thread as the bytes arrive, so a full pipe never blocks the CLI
/// and the output is usable even when a background job of a start-up file keeps the pipe open (no EOF).
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> (Arc<Mutex<Vec<u8>>>, std::thread::JoinHandle<()>) {
    let sink = Arc::new(Mutex::new(Vec::new()));
    let buf = sink.clone();
    let reader = std::thread::spawn(move || {
        let Some(mut pipe) = pipe else { return };
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(n) if n > 0 => buf.lock().unwrap().extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                _ => return,
            }
        }
    });
    (sink, reader)
}

/// The login shell, its flags and the script that execs the CLI: POSIX shells and fish (which puts the
/// arguments in `$argv`); any other shell (nushell, …) is replaced by `/bin/sh -l` (DESIGN §20.1 item 2).
fn login_shell() -> (String, &'static str, &'static str) {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    match shell.rsplit('/').next().unwrap_or_default().to_owned().as_str() {
        "sh" | "bash" | "zsh" | "dash" | "ash" | "ksh" | "mksh" => (shell, "-ilc", POSIX_EXEC),
        "fish" => (shell, "-ilc", "exec $argv"),
        _ => ("/bin/sh".into(), "-lc", POSIX_EXEC),
    }
}

/// `$SHELL -ilc 'exec "$0" "$@"' <bin> open --print-url --json [--next <path>] [repo]`: an app started
/// from a desktop menu has neither the user's PATH nor a clean environment (DESIGN §20.1 item 2).
fn run_cli(repo: Option<&str>, next: Option<&str>) -> Result<OpenUrlResult, String> {
    let (shell, flags, script) = login_shell();
    let bin = std::env::var("PROMPTGRAPH_BIN").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "promptgraph".into());
    let mut cmd = Command::new(&shell);
    cmd.arg(flags).arg(script).arg(&bin).args(OPEN_ARGS);
    cmd.args(next.into_iter().flat_map(|next| ["--next", next])).args(repo);
    for name in STRIPPED_ENV { cmd.env_remove(name); }
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(|k| STRIPPED_ENV_PREFIXES.iter().any(|p| k.starts_with(p))) {
            cmd.env_remove(&key);
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // A new session: no terminal for the interactive shell to take over, and one group to kill.
    unsafe { cmd.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) }) };
    let mut child = cmd.spawn().map_err(|e| format!("could not start {shell}: {e}"))?;
    let ((out, out_reader), (err, err_reader)) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let deadline = Instant::now() + CLI_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            status => break status,
        }
    };
    // The CLI wrote its output before exiting: give the readers a moment, then use what they have.
    let grace = Instant::now() + Duration::from_millis(500);
    while status.is_some() && !(out_reader.is_finished() && err_reader.is_finished()) && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(10));
    }
    // Then kill the session (the shell, or start-up file jobs): the pipes close; the daemon has its own session.
    unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
    let Some(status) = status else {
        let _ = child.wait();
        return Err("promptgraph did not answer within 30 s".into());
    };
    let [stdout, stderr] = [&out, &err].map(|sink| String::from_utf8_lossy(&sink.lock().unwrap()).into_owned());
    // Only 127 means not found: stderr also holds start-up files' messages, so text would hide a real failure.
    match status.code() {
        Some(127) => return Err(NOT_FOUND.into()),
        Some(2) => return Err(version_required()),
        Some(0) => {}
        _ => {
            let lines: Vec<&str> = stderr.trim().lines().collect();
            let tail = lines[lines.len().saturating_sub(10)..].join("\n");
            return Err(if tail.is_empty() { format!("promptgraph failed ({status})") } else { tail });
        }
    }
    // Shell start-up files may print to stdout: the last line that parses as a JSON object counts.
    let last = stdout.lines().rev()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok().filter(|v| v.is_object()))
        .ok_or_else(version_required)?;
    if last.get("v") != Some(&serde_json::json!(1)) { return Err(version_required()); }
    serde_json::from_value(last).map_err(|_| version_required())
}

/// The URL to load and the origin to allow: the login URL on `http://127.0.0.1:<port>`.
fn target(opened: &OpenUrlResult) -> Result<(Url, String), String> {
    let url = Url::parse(&opened.url).map_err(|_| version_required())?;
    if url.origin().ascii_serialization() != format!("http://127.0.0.1:{}", opened.port) {
        return Err("promptgraph returned an unexpected address".into());
    }
    #[cfg(debug_assertions)]
    let url = dev_rewrite(url)?;
    let origin = url.origin().ascii_serialization();
    Ok((url, origin))
}

/// Debug builds only: load the UI from the vite dev server, which proxies `/login` (DESIGN §20.2).
#[cfg(debug_assertions)]
fn dev_rewrite(mut url: Url) -> Result<Url, String> {
    let Ok(dev) = std::env::var("PG_DESKTOP_ORIGIN") else { return Ok(url) };
    let dev = Url::parse(&dev).map_err(|_| "PG_DESKTOP_ORIGIN is not a URL".to_string())?;
    let _ = url.set_scheme(dev.scheme());
    url.set_host(dev.host_str()).map_err(|e| e.to_string())?;
    let _ = url.set_port(dev.port());
    Ok(url)
}

/// The runtime capability of one daemon origin: exactly the origin and its paths, never a wildcard port.
fn capability(origin: &str, port: u16) -> CapabilityBuilder {
    let cap = CapabilityBuilder::new(format!("remote-{port}")).window("main").local(false)
        .remote(origin.to_string()).remote(format!("{origin}/*"));
    let cap = PERMISSIONS.iter().fold(cap, |cap, permission| cap.permission(*permission));
    let https = vec![serde_json::json!({ "url": "https://*" })];
    cap.permission_scoped(OPENER_PERMISSION, https, Vec::<serde_json::Value>::new())
}

/// Grants the origin IPC once, allows it and navigates the window to the login URL. A failure leaves the
/// allowed origin and the splash flag as they were, so the page the window shows keeps working.
fn go(app: &AppHandle, shared: &Shared, opened: OpenUrlResult) -> Result<(), String> {
    let (url, origin) = target(&opened)?;
    let port = url.port_or_known_default().unwrap_or(opened.port);
    let window = app.get_webview_window("main").ok_or("the window is gone")?;
    let mut granted = shared.granted.lock().unwrap();
    if !granted.contains(&origin) {
        app.add_capability(capability(&origin, port)).map_err(|e| format!("could not grant access: {e}"))?;
        granted.insert(origin.clone());
    }
    let previous = shared.origin.lock().unwrap().replace(origin);
    let was_splash = shared.showing_splash.swap(false, Ordering::SeqCst);
    // The page draws its own title bar from now on (the splash keeps the native frame).
    let _ = window.set_decorations(!shared.custom);
    // Never the error text: it could quote the login URL.
    window.navigate(url).map_err(|_| {
        *shared.origin.lock().unwrap() = previous;
        shared.showing_splash.store(was_splash, Ordering::SeqCst);
        "could not open promptgraph in the window".to_string()
    })
}

/// Every time the splash finishes loading: run the CLI, then navigate or show the error on the splash.
fn start_from_splash(app: AppHandle, shared: Arc<Shared>) {
    std::thread::spawn(move || {
        let Ok(_cli) = shared.cli.try_lock() else { return };
        let result = run_cli(shared.repo.as_deref(), None).and_then(|opened| go(&app, &shared, opened));
        if let Err(message) = result {
            shared.showing_splash.store(true, Ordering::SeqCst);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(true);
                let arg = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".into());
                let _ = window.eval(&format!("window.__pgSplashError({arg})"));
            }
        }
    });
}

fn safe_next(next: &str) -> bool {
    next.starts_with('/') && !next.contains("//") && !next.contains('\\') && !next.chars().any(char::is_control)
}

/// The page is signed out or the daemon is unreachable (DESIGN §13.5): run the CLI again with
/// `--next`, follow its origin and navigate. Never returns a URL, a code or the token.
#[tauri::command]
async fn relogin(app: AppHandle, next: String) -> Result<(), String> {
    if !safe_next(&next) { return Err("invalid path".into()); }
    let shared = app.state::<Arc<Shared>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _cli = shared.cli.lock().unwrap();
        let opened = run_cli(None, Some(&next))?;
        go(&app, &shared, opened)
    }).await.map_err(|_| "sign-in failed".to_string())?
}

fn is_splash(url: &Url, dev_origin: &Option<String>) -> bool {
    url.scheme() == "tauri" || dev_origin.as_deref() == Some(url.origin().ascii_serialization().as_str())
}

/// `PG_DESKTOP_DECORATIONS=custom|native`; native by default under WSLg (DESIGN §20.2).
fn custom_title_bar() -> bool {
    match std::env::var("PG_DESKTOP_DECORATIONS").as_deref() {
        Ok("native") => false,
        Ok("custom") => true,
        _ => std::env::var_os("WSL_DISTRO_NAME").is_none(),
    }
}

fn build_window(app: &AppHandle, shared: Arc<Shared>) -> tauri::Result<()> {
    let custom = shared.custom;
    let (nav, load, nav_app, popup_app, load_app) = (shared.clone(), shared, app.clone(), app.clone(), app.clone());
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("promptgraph")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .decorations(true)
        .initialization_script(format!("window.__PG_DESKTOP__ = Object.freeze({{ customTitleBar: {custom} }});"))
        .on_navigation(move |url| {
            if is_splash(url, &nav.dev_origin) {
                return nav.showing_splash.load(Ordering::SeqCst);
            }
            let origin = url.origin().ascii_serialization();
            if nav.origin.lock().unwrap().as_deref() == Some(origin.as_str()) { return true; }
            if url.scheme() == "https" { let _ = nav_app.opener().open_url(url.as_str(), None::<&str>); }
            false
        })
        .on_new_window(move |url, _features| {
            if url.scheme() == "https" { let _ = popup_app.opener().open_url(url.as_str(), None::<&str>); }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) && is_splash(payload.url(), &load.dev_origin) {
                start_from_splash(load_app.clone(), load.clone());
            }
        })
        .build().map(|_window| ())
}

/// `promptgraph-desktop [repo-dir]`, made absolute even when it does not exist, so the CLI never reads it as
/// an option (`-h` becomes `<cwd>/-h`). Not `std::path::absolute`: that needs Rust 1.79.
fn repo_arg(arg: OsString) -> String {
    let path = PathBuf::from(arg);
    std::fs::canonicalize(&path)
        .or_else(|_| std::env::current_dir().map(|dir| dir.join(&path)))
        .unwrap_or_else(|_| Path::new(".").join(&path))
        .to_string_lossy().into_owned()
}

fn main() {
    let repo = std::env::args_os().nth(1).map(repo_arg);
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![relogin])
        .setup(move |app| {
            let dev_url = app.config().build.dev_url.as_ref().filter(|_| tauri::is_dev());
            let dev_origin = dev_url.map(|url| url.origin().ascii_serialization());
            let shared = Arc::new(Shared {
                origin: Mutex::new(None),
                showing_splash: AtomicBool::new(true),
                granted: Mutex::new(HashSet::new()),
                cli: Mutex::new(()),
                repo,
                custom: custom_title_bar(),
                dev_origin,
            });
            app.manage(shared.clone());
            Ok(build_window(app.handle(), shared)?)
        })
        .run(tauri::generate_context!())
        .expect("error while running promptgraph");
}
