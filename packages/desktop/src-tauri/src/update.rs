//! Signed updates from GitHub Releases, driven only from Rust (DESIGN §20.10): no updater, dialog or process
//! permission reaches any webview. AppImage updates replace the file `APPIMAGE` names, so they run only when
//! that file provably is the running app.

use std::collections::HashSet;
use std::ffi::OsString;
use std::os::unix::{fs::MetadataExt, process::CommandExt};
use std::path::{Path, PathBuf};
use std::sync::{atomic::Ordering, Arc};
use std::time::{Duration, Instant};

use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::dialog::{ask, plain_text};
use crate::{splash, Shared};

const SPLASH_URL: &str = "tauri://localhost/index.html";
const FIRST_CHECK: Duration = Duration::from_secs(5);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const NOTES_MAX_CHARS: usize = 600;
/// The check's 30 s timeout does not reach the download (the plugin builds `Update` with none): a download
/// that receives nothing for this long fails (`update-failed`) instead of keeping the splash forever, while
/// a slow but moving one is never cut off.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Starts the background update check, or explains on stderr (once) why there is none.
pub fn spawn(app: &AppHandle) {
    if let Err(reason) = gate(app) {
        eprintln!("promptgraph-desktop: no update checks: {reason}");
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        let mut declined = HashSet::new();
        loop {
            let checked = app.updater_builder().timeout(Duration::from_secs(30))
                .configure_client(|client| client.read_timeout(STALL_TIMEOUT)).build()
                .map(|updater| tauri::async_runtime::block_on(updater.check()));
            match checked {
                Ok(Ok(Some(update))) if !declined.contains(&update.version) => offer(&app, update, &mut declined),
                Ok(Ok(_)) => {}
                Ok(Err(e)) | Err(e) => eprintln!("promptgraph-desktop: update check failed: {e}"),
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

fn gate(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) { return Err("debug build".into()); }
    let updater = app.config().plugins.0.get("updater");
    let pubkey = updater.and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).unwrap_or_default();
    if pubkey.trim().is_empty() { return Err("no updater public key in this build".into()); }
    if std::env::var("PG_DESKTOP_UPDATES").as_deref() == Ok("0") { return Err("PG_DESKTOP_UPDATES=0".into()); }
    match bundle_type() {
        Some(BundleType::Deb) => Ok(()),
        Some(BundleType::AppImage) => {
            let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
            let tmp = std::env::var_os("TMPDIR").filter(|t| !t.is_empty()).map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
            appimage_is_self(&|name| std::env::var_os(name), &exe, &tmp, unsafe { libc::getuid() })
        }
        _ => Err("not running from a .deb or an AppImage".into()),
    }
}

/// `APPIMAGE` names the running app: the variable is inherited, so an extracted `squashfs-root/AppRun`, or a
/// binary started from another AppImage's terminal, would otherwise replace another app's file.
fn appimage_is_self(env: &dyn Fn(&str) -> Option<OsString>, exe: &Path, tmp: &Path, uid: u32) -> Result<(), String> {
    let appdir = crate::appdir_of(env, exe)?;
    let tmp_dirs = [std::fs::canonicalize(tmp).ok(), std::fs::canonicalize("/tmp").ok()];
    if !tmp_dirs.iter().flatten().any(|dir| appdir.parent() == Some(dir.as_path())) {
        return Err("APPDIR is not a mount in the temporary directory".into());
    }
    let mount = appdir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let image = PathBuf::from(env("APPIMAGE").ok_or("APPIMAGE is not set")?);
    if !image.is_absolute() { return Err("APPIMAGE is not absolute".into()); }
    let name = image.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if let Some(rest) = mount.strip_prefix(".mount_") {
        let prefix: String = name.chars().take(6).collect();
        if !rest.starts_with(&prefix) { return Err("APPDIR is not the mount of APPIMAGE".into()); }
    } else if !mount.starts_with("appimage_extracted_") {
        return Err("APPDIR is not an AppImage mount".into());
    }
    let meta = std::fs::symlink_metadata(&image).map_err(|e| format!("APPIMAGE: {e}"))?;
    if !meta.file_type().is_file() { return Err("APPIMAGE is not a regular file".into()); }
    if meta.uid() != uid { return Err("APPIMAGE is owned by another user".into()); }
    if !name.to_ascii_lowercase().contains("promptgraph") { return Err("APPIMAGE is not a promptgraph AppImage".into()); }
    Ok(())
}

/// Asks; on "update" shows the splash, downloads, verifies and installs, then restarts the app.
fn offer(app: &AppHandle, update: Update, declined: &mut HashSet<String>) {
    let notes: String = plain_text(update.body.as_deref().unwrap_or("")).trim().chars().take(NOTES_MAX_CHARS).collect();
    let how = match bundle_type() {
        Some(BundleType::Deb) => "Installing asks for your password.",
        _ => "The AppImage file is replaced in place.",
    };
    let (version, current) = (update.version.clone(), update.current_version.clone());
    let text = format!("promptgraph {version} is available (you have {current}).\n\nRelease notes (from GitHub):\n{notes}\n\n{how}");
    let buttons = [("update", "Update and restart".to_string()), ("later", "Later".to_string())];
    match ask(app, "update", "An update is available", &text, &buttons, 1) {
        Some("update") => {}
        Some(_) => { declined.insert(version); return; }
        None => return, // not shown: asked again at the next check
    }
    let shared = app.state::<Arc<Shared>>().inner().clone();
    // No CLI call may navigate the window away from the splash while the update runs.
    let cli = shared.cli.lock().unwrap_or_else(|e| e.into_inner());
    shared.restarting.store(true, Ordering::SeqCst);
    show_splash(app, &shared);
    let status = format!("Downloading promptgraph {version}…");
    splash(app, "__pgSplashStatus", &status);
    let (mut received, mut shown) = (0u64, u64::MAX);
    let result = tauri::async_runtime::block_on(update.download_and_install(
        |chunk, total| {
            received += chunk as u64;
            let percent = total.filter(|t| *t > 0).map_or(0, |t| (received * 100 / t).min(100));
            if percent != shown {
                shown = percent;
                splash(app, "__pgSplashStatus", &format!("{status} {percent}%"));
            }
        },
        || {},
    ));
    match result {
        Ok(()) => {
            if let Err(e) = relaunch(app) {
                eprintln!("promptgraph-desktop: could not restart: {e}");
                let text = format!("promptgraph {version} is installed, but the app could not start it: {e}.\n\nStart promptgraph again to use the new version.");
                ask(app, "restart-failed", "Restart promptgraph", &text, &[("ok", "OK".to_string())], 0);
            }
            app.exit(0);
        }
        Err(e) => {
            let text = format!("The update could not be installed: {e}. promptgraph {current} keeps running.");
            ask(app, "update-failed", "The update failed", &text, &[("ok", "OK".to_string())], 0);
            shared.restarting.store(false, Ordering::SeqCst);
            drop(cli);
            // A fresh splash load runs the normal start, back to the daemon's page.
            show_splash(app, &shared);
        }
    }
}

/// Starts the binary `AppHandle::restart()` would start, with this process's arguments. Not `restart()`
/// itself: its variables, directory and inherited descriptors keep the old mount alive (§20.10).
fn relaunch(app: &AppHandle) -> Result<(), String> {
    let env = app.env();
    let binary = tauri::process::current_binary(&env).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(binary);
    crate::strip_env(cmd.args(env.args_os.iter().skip(1)), false);
    unsafe { cmd.pre_exec(|| { libc::syscall(libc::SYS_close_range, 3, u32::MAX, libc::CLOSE_RANGE_CLOEXEC); Ok(()) }) };
    cmd.spawn().map(drop).map_err(|e| e.to_string())
}

/// Navigates to the splash (the daemon's page is unloaded and flushes its edits) and waits ≤ 2 s for it.
fn show_splash(app: &AppHandle, shared: &Shared) {
    shared.showing_splash.store(true, Ordering::SeqCst);
    let loads = shared.splash_loads.load(Ordering::SeqCst);
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.set_decorations(true);
    if window.navigate(Url::parse(SPLASH_URL).expect("splash URL")).is_err() { return; }
    let deadline = Instant::now() + Duration::from_secs(2);
    while shared.splash_loads.load(Ordering::SeqCst) == loads && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::appimage_is_self;
    use std::path::{Path, PathBuf};

    struct Fake {
        root: PathBuf,
    }

    impl Fake {
        /// `<root>/tmp/<mount>/usr/bin/promptgraph-desktop` and `<root>/apps/<image>`.
        fn new(tag: &str, mount: &str, image: &str) -> (Fake, PathBuf, PathBuf, PathBuf) {
            let root = std::env::temp_dir().join(format!("pg-update-test-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let appdir = root.join("tmp").join(mount);
            let exe = appdir.join("usr/bin/promptgraph-desktop");
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            std::fs::write(&exe, b"").unwrap();
            std::fs::create_dir_all(root.join("apps")).unwrap();
            let image = root.join("apps").join(image);
            std::fs::write(&image, b"").unwrap();
            (Fake { root }, appdir, exe, image)
        }

        fn check(&self, appdir: &Path, image: &Path, exe: &Path) -> Result<(), String> {
            let vars = [("APPDIR", appdir.as_os_str().to_owned()), ("APPIMAGE", image.as_os_str().to_owned())];
            let env = move |name: &str| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| v.clone());
            appimage_is_self(&env, exe, &self.root.join("tmp"), unsafe { libc::getuid() })
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    #[test]
    fn accepts_the_fuse_mount_of_the_running_appimage() {
        let (fake, appdir, exe, image) = Fake::new("ok", ".mount_promptAbc123", "promptgraph_0.2.0_amd64.AppImage");
        assert_eq!(fake.check(&appdir, &image, &exe), Ok(()));
    }

    #[test]
    fn accepts_an_extract_and_run_directory() {
        let (fake, appdir, exe, image) = Fake::new("extracted", "appimage_extracted_0123abcd", "Promptgraph.AppImage");
        assert_eq!(fake.check(&appdir, &image, &exe), Ok(()));
    }

    #[test]
    fn refuses_an_inherited_appimage_when_the_binary_is_elsewhere() {
        let (fake, appdir, _exe, image) = Fake::new("inherited", ".mount_promptAbc123", "promptgraph.AppImage");
        let other = fake.root.join("apps/promptgraph-desktop");
        std::fs::write(&other, b"").unwrap();
        assert!(fake.check(&appdir, &image, &other).unwrap_err().contains("not inside APPDIR"));
    }

    #[test]
    fn refuses_an_extracted_squashfs_root() {
        let (fake, _appdir, _exe, image) = Fake::new("squashfs", ".mount_promptAbc123", "promptgraph.AppImage");
        let appdir = fake.root.join("apps/squashfs-root");
        let exe = appdir.join("usr/bin/promptgraph-desktop");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        assert!(fake.check(&appdir, &image, &exe).unwrap_err().contains("temporary directory"));
        // Also when someone extracted it into the temporary directory itself.
        let tmp_root = fake.root.join("tmp/squashfs-root");
        let exe = tmp_root.join("AppRun");
        std::fs::create_dir_all(&tmp_root).unwrap();
        std::fs::write(&exe, b"").unwrap();
        assert!(fake.check(&tmp_root, &image, &exe).unwrap_err().contains("not an AppImage mount"));
    }

    #[test]
    fn refuses_another_apps_appimage() {
        let (fake, appdir, exe, image) = Fake::new("name", ".mount_OtherAAbc123", "OtherApp-x86_64.AppImage");
        assert!(fake.check(&appdir, &image, &exe).unwrap_err().contains("not a promptgraph AppImage"));
        // A mount that does not carry the image's name is another AppImage's mount.
        let (fake, appdir, exe, image) = Fake::new("mount", ".mount_OtherAAbc123", "promptgraph.AppImage");
        assert!(fake.check(&appdir, &image, &exe).unwrap_err().contains("not the mount of APPIMAGE"));
    }

    #[test]
    fn refuses_a_symlinked_or_relative_appimage() {
        let (fake, appdir, exe, image) = Fake::new("symlink", ".mount_promptAbc123", "real.AppImage");
        let link = fake.root.join("apps/promptgraph.AppImage");
        std::os::unix::fs::symlink(&image, &link).unwrap();
        assert!(fake.check(&appdir, &link, &exe).unwrap_err().contains("not a regular file"));
        assert!(fake.check(&appdir, Path::new("promptgraph.AppImage"), &exe).unwrap_err().contains("not absolute"));
    }
}
