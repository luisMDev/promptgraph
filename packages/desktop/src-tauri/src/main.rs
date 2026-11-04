//! promptgraph desktop shell (DESIGN §20): one window around the web UI served by the Node daemon, which it
//! reaches only through the CLI. No logic beyond the window, the CLI call, the allowed origin, the runtime
//! capability, the guards, splash errors and `relogin`, plus, for distribution, the runtime installer, the
//! command shim and handover questions (dialog.rs) and the update check (update.rs);
//! `packages/desktop/test/contract.test.ts` checks them as text.

mod dialog;
mod update;

use std::{collections::HashSet, ffi::OsString, io::Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use dialog::ask;
use serde::{de::DeserializeOwned, Deserialize};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

/// `promptgraph open --print-url --json` (DESKTOP_OPEN_ARGS in packages/shared/src/desktop.ts).
const OPEN_ARGS: [&str; 3] = ["open", "--print-url", "--json"];
/// Removed from the CLI's environment (DESKTOP_STRIPPED_ENV / DESKTOP_STRIPPED_ENV_PREFIXES).
const STRIPPED_ENV: [&str; 8] = [
    "LD_LIBRARY_PATH", "LD_PRELOAD", "APPDIR", "APPIMAGE", "ARGV0", "OWD", "PG_DESKTOP_AUTO_ANSWER", "PG_DESKTOP_UPDATES",
];
const STRIPPED_ENV_PREFIXES: [&str; 6] = ["GTK_", "GDK_", "GIO_", "GI_", "GSETTINGS_", "WEBKIT_"];
/// Granted to the daemon's origin (DESKTOP_PERMISSIONS); the opener one is added scoped to https.
const PERMISSIONS: [&str; 9] = [
    "core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-internal-toggle-maximize",
    "core:window:allow-is-maximized", "core:window:allow-close", "core:window:allow-start-dragging",
    "core:window:allow-start-resize-dragging", "core:window:allow-set-title", "allow-relogin",
];
const OPENER_PERMISSION: &str = "opener:allow-open-url";
/// `<runtime>/bin/promptgraph desktop install --json` (DESKTOP_INSTALL_ARGS).
const INSTALL_ARGS: [&str; 3] = ["desktop", "install", "--json"];
/// `open`'s stderr line before it stops a daemon of another version (DAEMON_RESTART_PROGRESS_PREFIX).
const RESTART_PROGRESS: &str = "promptgraph: restarting the daemon";
/// `open --on-version-mismatch` exit code: the user must decide (EXIT_VERSION_MISMATCH, OpenMismatchResult).
const EXIT_VERSION_MISMATCH: i32 = 4;
/// Budgets (DESIGN §20.1 item 4): attach, CLIs without a runtime and the shim commands; auto and restart,
/// which may stop a daemon and start another; the runtime installer.
const CLI_TIMEOUT: Duration = Duration::from_secs(30);
const HANDOVER_TIMEOUT: Duration = Duration::from_secs(90);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Execs the CLI with the shell's remaining arguments (`$0` is the binary).
const POSIX_EXEC: &str = r#"exec "$0" "$@""#;
const NOT_FOUND: &str = "promptgraph CLI not found: install it with `npm i -g promptgraph` or set `PROMPTGRAPH_BIN`";

/// The fields of OpenUrlResult the shell needs (OpenUrlResultSchema; `v` is checked first).
#[derive(Deserialize)]
struct OpenUrlResult { url: String, port: u16 }

/// OpenMismatchResult (`open` exit 4), DesktopInstallResult and ShimResult: the fields the questions need.
#[derive(Deserialize)]
struct OpenMismatchResult { v: u8, mismatch: Mismatch }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mismatch { server_version: String, cli_version: String, running_runs: Option<u64>, daemon_is_older: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInstallResult { cli_path: String, shim: ShimStatus }
#[derive(Deserialize)]
struct ShimResult { shim: ShimStatus }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShimStatus {
    path: String, state: String, foreign_target: Option<String>, decision: Option<String>,
    shadowed_by: Option<String>, path_hint: Option<String>, warn: bool,
}

/// The CLI the shell runs; `bundled`: the bundled runtime's versioned launcher.
struct Cli { path: String, bundled: bool }
struct Captured { status: ExitStatus, stdout: String, stderr: String }

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
    bin: OnceLock<Cli>, // resolved once per process (DESIGN §20.7)
    /// `--on-version-mismatch`: "auto", or "attach" for the rest of the process once the user kept a daemon.
    mismatch_policy: Mutex<&'static str>,
    /// An accepted update shows the splash: its load must not run the CLI (DESIGN §20.10).
    restarting: AtomicBool,
    splash_loads: AtomicU64,
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

/// Runs `cmd` with the stripped environment, no stdin and in a new session (no terminal for an interactive
/// shell to take over, one group to kill). Output is read as it arrives (complete stderr lines go to
/// `on_stderr_line`) and used 500 ms after exit even without EOF; then the whole session is killed on every
/// path, so jobs of start-up files close the pipes (the daemon has its own session).
fn run_captured(mut cmd: Command, timeout: Duration, on_stderr_line: &dyn Fn(&str)) -> Result<Captured, String> {
    for name in STRIPPED_ENV { cmd.env_remove(name); }
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(|k| STRIPPED_ENV_PREFIXES.iter().any(|p| k.starts_with(p))) {
            cmd.env_remove(&key);
        }
    }
    // AppRun and the AppImage's GTK hook prepend the mount, which disappears with the app (APPDIR is read
    // from this process: it is removed only from the child's environment).
    let appdir = std::env::var("APPDIR").unwrap_or_default();
    for name in ["PATH", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS"] {
        match std::env::var(name).map(|value| without_dirs_under(&value, &appdir)) {
            Ok(Some(value)) => { cmd.env(name, value); }
            Ok(None) => { cmd.env_remove(name); }
            Err(_) => {}
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    unsafe { cmd.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) }) };
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd.spawn().map_err(|e| format!("could not start {program}: {e}"))?;
    let ((out, out_reader), (err, err_reader)) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let mut forwarded = 0;
    let mut forward = || {
        let lines: Vec<String> = {
            let buf = err.lock().unwrap();
            let end = buf.iter().rposition(|b| *b == b'\n').map_or(forwarded, |i| i + 1).max(forwarded);
            let lines = String::from_utf8_lossy(&buf[forwarded..end]).lines().map(str::to_owned).collect();
            forwarded = end;
            lines
        };
        lines.iter().for_each(|line| on_stderr_line(line));
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        forward();
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
    unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
    let Some(status) = status else {
        let _ = child.wait();
        return Err(format!("promptgraph did not answer within {} s", timeout.as_secs()));
    };
    forward();
    let [stdout, stderr] = [&out, &err].map(|sink| String::from_utf8_lossy(&sink.lock().unwrap()).into_owned());
    Ok(Captured { status, stdout, stderr })
}

/// `PATH`/`XDG_DATA_DIRS`/`XDG_CONFIG_DIRS` without the entries under `appdir`; None when nothing is left.
fn without_dirs_under(value: &str, appdir: &str) -> Option<String> {
    let kept: Vec<&str> = value.split(':')
        .filter(|dir| !dir.is_empty() && (appdir.is_empty() || !Path::new(dir).starts_with(appdir)))
        .collect();
    (!kept.is_empty()).then(|| kept.join(":"))
}

/// The last 10 lines of stderr: the CLI's message (stderr also carries start-up files' messages).
fn stderr_tail(out: &Captured) -> String {
    let lines: Vec<&str> = out.stderr.trim().lines().collect();
    let tail = lines[lines.len().saturating_sub(10)..].join("\n");
    if tail.is_empty() { format!("promptgraph failed ({})", out.status) } else { tail }
}

/// Runs a command of the bundled runtime directly (no login shell: it needs nothing from PATH) and parses
/// its one `{"v":1,…}` line. The runtime is this app's own version, so a missing line is its failure, not
/// an old CLI.
fn run_json<T: DeserializeOwned>(program: &str, args: &[&str], timeout: Duration) -> Result<T, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    let out = run_captured(cmd, timeout, &|_| {})?;
    if !out.status.success() { return Err(stderr_tail(&out)); }
    let last = last_json_object(&out.stdout).filter(|last| last.get("v") == Some(&serde_json::json!(1)));
    last.and_then(|last| serde_json::from_value(last).ok())
        .ok_or_else(|| format!("`promptgraph {}` returned no result\n{}", args.join(" "), stderr_tail(&out)))
}

/// The CLI the shell runs, resolved once per process (DESIGN §20.7): PROMPTGRAPH_BIN; else the bundled
/// runtime, installed into the per-user data directory, through its versioned launcher; else `promptgraph`
/// from the login shell's PATH. An install failure is shown as is, without falling back to another CLI.
fn cli_bin<'a>(app: &AppHandle, shared: &'a Shared) -> Result<&'a Cli, String> {
    if let Some(cli) = shared.bin.get() { return Ok(cli); }
    let runtime = app.path().resource_dir().map(|dir| dir.join("runtime"));
    let cli = if let Some(path) = std::env::var("PROMPTGRAPH_BIN").ok().filter(|s| !s.is_empty()) {
        Cli { path, bundled: false }
    } else if let Some(runtime) = runtime.ok().filter(|dir| dir.join("manifest.json").is_file()) {
        Cli { path: install_runtime(app, &runtime)?, bundled: true }
    } else {
        Cli { path: "promptgraph".into(), bundled: false }
    };
    Ok(shared.bin.get_or_init(|| cli))
}

/// `desktop install`, then the `~/.local/bin/promptgraph` question when there is no decision yet, then the
/// PATH warning (DESIGN §20.8). Returns the versioned launcher, never one through `current`.
fn install_runtime(app: &AppHandle, runtime: &Path) -> Result<String, String> {
    splash(app, "__pgSplashStatus", &format!("Installing promptgraph {}…", env!("CARGO_PKG_VERSION")));
    let launcher = runtime.join("bin").join("promptgraph").to_string_lossy().into_owned();
    let installed: DesktopInstallResult = run_json(&launcher, &INSTALL_ARGS, INSTALL_TIMEOUT)
        .map_err(|e| format!("The promptgraph runtime could not be installed:\n{e}"))?;
    let mut shim = installed.shim;
    // A question that could not be shown records nothing: it is asked again on the next start.
    if let Some(args) = (shim.decision.is_none() && shim.state != "ours").then(|| shim_question(app, &shim)).flatten() {
        match run_json::<ShimResult>(&installed.cli_path, &args, CLI_TIMEOUT) {
            Ok(result) => shim = result.shim,
            Err(e) => {
                eprintln!("promptgraph-desktop: {} failed: {e}", args.join(" "));
                if args.contains(&"install") { shim_failed(app, &shim.path, &e); }
                shim.warn = false; // the old status says nothing about a command that is not there
            }
        }
    }
    if shim.warn { path_warning(app, &shim); }
    splash(app, "__pgSplashStatus", "Starting promptgraph…");
    Ok(installed.cli_path)
}

/// `shim-offer` (absent) or `shim-replace` (foreign); returns the `desktop shim` command that records the
/// answer, None when the question could not be shown.
fn shim_question(app: &AppHandle, shim: &ShimStatus) -> Option<Vec<&'static str>> {
    let decline = vec!["desktop", "shim", "decline", "--json"];
    if shim.state == "absent" {
        let text = "It lets terminals and the Claude Code plugin use the promptgraph that comes with this app. \
            It is a small script in ~/.local/bin.";
        let buttons = [("install", "Install".to_string()), ("skip", "Not now".to_string())];
        let install = ask(app, "shim-offer", "Install the promptgraph command?", text, &buttons, 1)? == "install";
        return Some(if install { vec!["desktop", "shim", "install", "--json"] } else { decline });
    }
    let target = shim.foreign_target.as_deref().map(|t| format!(" (→ {t})")).unwrap_or_default();
    let text = format!("{}{target} already exists and was not installed by this app. Replace it with the app's \
        command? The current file is kept as promptgraph.bak.", shim.path);
    let buttons = [("keep", "Keep the existing one".to_string()), ("replace", "Replace".to_string())];
    Some(match ask(app, "shim-replace", "Replace the promptgraph command?", &text, &buttons, 0)? {
        "replace" => vec!["desktop", "shim", "install", "--replace", "--json"],
        _ => decline,
    })
}

fn shim_failed(app: &AppHandle, path: &str, error: &str) {
    let text = format!("{path} could not be installed:\n{error}\n\nThe app offers it again the next time it starts.");
    ask(app, "shim-failed", "The promptgraph command was not installed", &text, &[("ok", "OK".to_string())], 0);
}

fn path_warning(app: &AppHandle, shim: &ShimStatus) {
    let problem = match &shim.shadowed_by {
        Some(other) => format!("Another promptgraph comes first on your PATH ({other}), so terminals and the Claude Code plugin will not run the app's command."),
        None => "~/.local/bin is not on your PATH, so terminals and the Claude Code plugin will not find the promptgraph command.".into(),
    };
    let hint = shim.path_hint.as_deref().map(|h| format!("\n\nTo fix it, run:\n{h}\nthen open a new terminal.")).unwrap_or_default();
    ask(app, "path-warning", "The promptgraph command is not on your PATH", &format!("{problem}{hint}"), &[("ok", "OK".to_string())], 0);
}

/// `$SHELL -ilc 'exec "$0" "$@"' <bin> open --print-url --json --on-version-mismatch <policy> [--next <path>]
/// [repo]`: an app started from a desktop menu has neither the user's PATH nor a clean environment (DESIGN
/// §20.1 item 2). Exit 4 asks the version-mismatch question and runs the CLI once more (DESIGN §20.9).
fn run_cli(app: &AppHandle, shared: &Shared, repo: Option<&str>, next: Option<&str>) -> Result<OpenUrlResult, String> {
    let cli = cli_bin(app, shared)?;
    let mut policy = *shared.mismatch_policy.lock().unwrap();
    for attempt in 0..2 {
        let (shell, flags, script) = login_shell();
        let mut cmd = Command::new(&shell);
        cmd.arg(flags).arg(script).arg(&cli.path).args(OPEN_ARGS).args(["--on-version-mismatch", policy]);
        cmd.args(next.into_iter().flat_map(|next| ["--next", next])).args(repo);
        let timeout = if cli.bundled && policy != "attach" { HANDOVER_TIMEOUT } else { CLI_TIMEOUT };
        let progress = |line: &str| if line.starts_with(RESTART_PROGRESS) { splash(app, "__pgSplashStatus", line) };
        let out = run_captured(cmd, timeout, &progress)?;
        // Only 127 means not found: stderr also holds start-up files' messages, so text would hide a real failure.
        match out.status.code() {
            Some(127) => return Err(NOT_FOUND.into()),
            Some(2) => return Err(version_required()),
            Some(EXIT_VERSION_MISMATCH) if attempt == 0 => { policy = handover(app, shared, &out.stdout)?; continue; }
            Some(0) => {}
            Some(EXIT_VERSION_MISMATCH) => return Err(version_required()),
            _ => return Err(stderr_tail(&out)),
        }
        let last = last_json_object(&out.stdout).ok_or_else(version_required)?;
        if last.get("v") != Some(&serde_json::json!(1)) { return Err(version_required()); }
        return serde_json::from_value(last).map_err(|_| version_required());
    }
    Err(version_required())
}

/// The running daemon is another version and stopping it would interrupt work, or it is newer: ask, and
/// return the policy of the second call. Keeping it holds for the rest of the process (every relogin).
fn handover(app: &AppHandle, shared: &Shared, stdout: &str) -> Result<&'static str, String> {
    let result = last_json_object(stdout).and_then(|last| serde_json::from_value::<OpenMismatchResult>(last).ok());
    let Some(Mismatch { server_version: old, cli_version: new, running_runs, daemon_is_older }) =
        result.filter(|result| result.v == 1).map(|result| result.mismatch) else { return Err(version_required()) };
    let (text, buttons, default) = if daemon_is_older {
        let steps = running_runs.map_or("may be running steps".to_string(), |n| format!("is still running {n} step(s)"));
        let text = format!("promptgraph {old} {steps} from before the update to {new}. Restart it now? Running \
            steps are interrupted; their runs pause and can be resumed.");
        (text, [("restart", "Restart now".to_string()), ("keep", format!("Keep {old} for now"))], 1)
    } else {
        let text = format!("A newer promptgraph ({old}) is running. This app bundles {new}.");
        (text, [("use", "Use the running one".to_string()), ("restart", format!("Restart with {new}"))], 0)
    };
    if ask(app, "version-mismatch", "promptgraph is running another version", &text, &buttons, default) == Some("restart") {
        splash(app, "__pgSplashStatus", &format!("Restarting promptgraph {new}…"));
        return Ok("restart");
    }
    *shared.mismatch_policy.lock().unwrap() = "attach";
    Ok("attach")
}

/// Shell start-up files may print to stdout, even on the CLI's own line (terminal integrations such as
/// Warp emit escape sequences without a newline): the last JSON object that starts with `{"v":` counts,
/// else the last line that parses as a JSON object.
fn last_json_object(stdout: &str) -> Option<serde_json::Value> {
    let parse_at = |start: usize| {
        serde_json::Deserializer::from_str(&stdout[start..]).into_iter::<serde_json::Value>().next()
            .and_then(Result::ok).filter(serde_json::Value::is_object)
    };
    stdout.rmatch_indices("{\"v\":").find_map(|(start, _)| parse_at(start)).or_else(|| {
        stdout.lines().rev()
            .find_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok().filter(|v| v.is_object()))
    })
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
        let result = run_cli(&app, &shared, shared.repo.as_deref(), None).and_then(|opened| go(&app, &shared, opened));
        if let Err(message) = result {
            eprintln!("promptgraph-desktop: {message}");
            shared.showing_splash.store(true, Ordering::SeqCst);
            if let Some(window) = app.get_webview_window("main") { let _ = window.set_decorations(true); }
            splash(&app, "__pgSplashError", &message);
        }
    });
}

/// Calls `window.__pgSplashError` or `window.__pgSplashStatus` (splash.js), only while the splash is shown.
fn splash(app: &AppHandle, function: &str, text: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    let dev_origin = &app.state::<Arc<Shared>>().dev_origin;
    if !window.url().is_ok_and(|url| is_splash(&url, dev_origin)) { return; }
    let arg = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let _ = window.eval(format!("window.{function}({arg})"));
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
        let opened = run_cli(&app, &shared, None, Some(&next))?;
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
                load.splash_loads.fetch_add(1, Ordering::SeqCst);
                if !load.restarting.load(Ordering::SeqCst) { start_from_splash(load_app.clone(), load.clone()); }
            }
        })
        .build().map(|_window| ())
}

/// `promptgraph-desktop [repo-dir]`, made absolute even when it does not exist, so the CLI never reads it as
/// an option (`-h` becomes `<cwd>/-h`). Symlinks are resolved when the path exists.
fn repo_arg(arg: OsString) -> String {
    let path = PathBuf::from(arg);
    std::fs::canonicalize(&path)
        .or_else(|_| std::env::current_dir().map(|dir| dir.join(&path)))
        .unwrap_or_else(|_| Path::new(".").join(&path))
        .to_string_lossy().into_owned()
}

fn main() {
    dialog::init(); // before any child environment is built
    let repo = std::env::args_os().nth(1).map(repo_arg);
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
                bin: OnceLock::new(),
                mismatch_policy: Mutex::new("auto"),
                restarting: AtomicBool::new(false),
                splash_loads: AtomicU64::new(0),
            });
            app.manage(shared.clone());
            build_window(app.handle(), shared)?;
            update::spawn(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running promptgraph");
}

#[cfg(test)]
mod tests {
    use super::{last_json_object, without_dirs_under};

    #[test]
    fn drops_xdg_dirs_under_the_appimage_mount() {
        let appdir = "/tmp/.mount_promptAbc123";
        let value = "/tmp/.mount_promptAbc123/usr/share:/usr/local/share::/tmp/.mount_promptAbc1234/share:/usr/share";
        assert_eq!(without_dirs_under(value, appdir).as_deref(), Some("/usr/local/share:/tmp/.mount_promptAbc1234/share:/usr/share"));
        assert_eq!(without_dirs_under("/tmp/.mount_promptAbc123/usr/share", appdir), None);
        assert_eq!(without_dirs_under("/usr/share:/etc/xdg", "").as_deref(), Some("/usr/share:/etc/xdg"));
        let path = "/tmp/.mount_promptAbc123/usr/bin/:/home/u/.local/bin:/tmp/.mount_promptAbc123/bin/:/usr/bin";
        assert_eq!(without_dirs_under(path, appdir).as_deref(), Some("/home/u/.local/bin:/usr/bin"));
    }

    #[test]
    fn finds_the_cli_object_after_start_up_noise_on_the_same_line() {
        let out = "P$f{\"hook\": \"SourcedRcFileForWarp\", \"value\": {}}\u{9c}{\"v\":1,\"url\":\"u\",\"port\":4777}\n";
        assert_eq!(last_json_object(out).unwrap()["port"], 4777);
    }

    #[test]
    fn falls_back_to_the_last_json_line_and_rejects_garbage() {
        assert_eq!(last_json_object("hello\n{\"a\":1}\n").unwrap()["a"], 1);
        assert!(last_json_object("no json here\n[1]\n").is_none());
    }
}
