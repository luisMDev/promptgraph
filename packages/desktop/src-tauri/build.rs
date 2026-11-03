// The only app command is `relogin` (DESIGN §20.3). Declaring it in the app manifest generates the
// `allow-relogin` permission that the runtime capability grants to the daemon's origin.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["relogin"])),
    )
    .expect("failed to run tauri-build");
}
