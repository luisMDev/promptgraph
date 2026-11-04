# @promptgraph/desktop

A thin Tauri v2 shell for Linux around the promptgraph web UI ([DESIGN §20](../../docs/DESIGN.md#20-desktop-app-tauri-v2-linux)). It is not a backend: the Node daemon stays the only server and the window is one more client of it. The window's title bar is the in-app tab strip.

The released app (an AppImage and a `.deb`) works just by opening it. It carries a pinned Node, the promptgraph server, the web UI and the native modules (`node-pty`, `better-sqlite3`). On each start it copies them to `~/.local/share/promptgraph/runtime/` and runs the CLI from there. It never runs them from the AppImage's temporary mount, because the daemon it starts keeps running after the window closes. On the first start it offers to install the `promptgraph` command in `~/.local/bin`. It updates itself from GitHub Releases with signed artifacts.

How it works, in short:

1. `promptgraph-desktop [repo-dir]` opens one window on a bundled splash page ("Starting promptgraph…"). The splash always has the native window frame, so it can be moved and closed even when an error stops the start.
2. The shell picks the CLI, once per process (DESIGN §20.7):
   - `PROMPTGRAPH_BIN`, when it is set. Nothing is installed and nothing is asked.
   - Otherwise, the runtime the app bundles. The shell runs `<bundle>/runtime/bin/promptgraph desktop install --json`, which makes sure this build is installed in `~/.local/share/promptgraph/runtime/<version>-<id>/`. Then the shell asks the `promptgraph` command question once (below) and uses the launcher of that versioned directory.
   - Otherwise (a debug build, or a build without the runtime), `promptgraph` from the login shell's `PATH`.
3. Each time the splash finishes loading, the shell runs `$SHELL -ilc 'exec "$0" "$@"' <cli> open --print-url --json --on-version-mismatch auto [repo-dir]`. The login shell is used even with the bundled runtime, because the daemon takes the user's `PATH` from it, and `git` and `claude` are found there. The AppImage/GTK/WebKit variables and every `PATH` entry inside the AppImage's mount are removed first.
   - That form is used when `$SHELL` is `sh`, `bash`, `zsh`, `dash`, `ash`, `ksh` or `mksh`. With `fish` the script is `exec $argv`. Any other shell (nushell, …) is replaced by `/bin/sh -lc`, which reads `~/.profile`: put the `PATH` for promptgraph there, or set `PROMPTGRAPH_BIN`.
   - The shell runs in its own session (`setsid`). Its output is read as it arrives, so a background job that keeps the pipes open does not hide the CLI's line. Once the CLI has exited and its output was read, or on the timeout, the whole session is killed, including anything a start-up file started. The daemon is not in it.
   - The repository argument is made absolute first, even when it does not exist, so the CLI never reads it as an option.
4. The shell takes the last `{"v":` JSON object of stdout (start-up files may print escape sequences on the same line) and checks `v == 1`. It allows `http://127.0.0.1:<port>`, adds an IPC capability for exactly that origin at run time, turns the native frame off when the title bar is custom, and navigates to the one-time login URL. The shell never reads the token or `daemon.json`.
5. When the running daemon is another version (after an update), an idle older daemon is restarted on the new version without a question. If it is running steps, or it is newer, the app asks first (DESIGN §20.9).
6. Errors show on the splash, and **Retry** reloads it, which runs the CLI again. When the page is signed out or the daemon is unreachable, it calls the `relogin` command. That runs the CLI again with `--next <current path>`.

## Installing the app

Download `promptgraph_<version>_amd64.AppImage` or `promptgraph_<version>_amd64.deb` from the [releases](https://github.com/luisMDev/promptgraph/releases). Both need x86_64 Linux with glibc 2.35 or newer and WebKitGTK 4.1 (Ubuntu 22.04, Debian 12 or newer).

- AppImage: `chmod +x promptgraph_<version>_amd64.AppImage`, then run it. It needs FUSE (`libfuse2`); without FUSE, run it with `--appimage-extract-and-run` (updates then need the AppImage file itself, see the checklist).
- `.deb`: `sudo apt install ./promptgraph_<version>_amd64.deb`, then start **promptgraph** from the desktop menu or run `promptgraph-desktop`.

You install these yourself; the app reports any that are missing:

- `git`
- `claude` (Claude Code), signed in
- `curl`: Claude's hooks report through it. Without it, prompt steps never complete.
- `gh`, signed in, for pull-request steps

On the first start, the app asks whether to install the `promptgraph` command in `~/.local/bin`. Say yes if you want to use promptgraph from a terminal or from the Claude Code plugin (which runs `${PROMPTGRAPH_BIN:-promptgraph} mcp`). The command is a small script that runs the app's current runtime, so it keeps working after updates. If `~/.local/bin` already holds another `promptgraph`, the app asks before replacing it, and it keeps the old file as `promptgraph.bak`. If `~/.local/bin` is not on your `PATH`, the app shows the exact line to add to your shell's start-up file. The answer is remembered in `~/.config/promptgraph/desktop.json`. Later, run `promptgraph desktop shim install --json` to install the command or `promptgraph desktop shim uninstall --json` to remove it.

## Prerequisites for building

None of this is needed for `pnpm install`, `pnpm build`, `pnpm typecheck` or `pnpm test`. This package has no `build` script, and its tests read the Rust, JSON and workflow files as text.

- Rust 1.90 or newer (`rust-version` in `src-tauri/Cargo.toml`); CI pins 1.99.0.
- Tauri's Linux prerequisites:
  ```sh
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev patchelf xdg-utils
  ```
- For the bundled runtime (`pnpm runtime:prepare`): `python3`, `make` and `g++` (node-pty compiles from source), `xz-utils` and `binutils` (`strip`). The script downloads the pinned Node tarball once into `${XDG_CACHE_HOME:-~/.cache}/promptgraph-build/` and checks its SHA-256 on every use.
- The Tauri CLI, from cargo and not npm, at the version that matches the `tauri ~2.12` pin:
  ```sh
  cargo install tauri-cli --version 2.12.4 --locked
  ```
- On WSL, the window needs WSLg (Windows 11, or Windows 10 with WSLg installed).
- For `pnpm tauri:dev`, the promptgraph CLI must be on the `PATH` of your login shell, or set `PROMPTGRAPH_BIN=/abs/path/to/promptgraph`.

## Pinned Tauri version

`src-tauri/Cargo.toml` pins **`tauri = "~2.12"`** and the build dependency **`tauri-build = "~2.7"`**, the minor released with it (both use tauri-utils ~2.10; a newer tauri-build would mix two tauri-utils versions). It also has `tauri-plugin-opener = "2"`, `tauri-plugin-updater = "~2.14"`, `gtk = "0.18"` (the version tauri already uses; for the native questions) and `libc = "0.2"` (for `setsid` and `kill`). `rust-version` is 1.90, the minimum of those crates. The shell needs these APIs:

- `WebviewWindowBuilder::on_new_window` and `NewWindowResponse`, available since 2.8;
- `Manager::add_capability` with `ipc::CapabilityBuilder`, from the default `dynamic-acl` feature;
- `on_navigation`, `on_page_load`, `initialization_script` and `WebviewWindow::set_decorations`.

To move to a newer minor, change both pins together (tauri and the tauri-build released with it), and the `tauri-cli` version in this README and in `.github/workflows/release-desktop.yml`. Then rebuild and run the checklist below again. `src-tauri/Cargo.lock` is committed. `src-tauri/permissions/autogenerated/` (written by tauri-build for the `relogin` command) is ignored.

There is no dialog or process plugin. The dialog plugin would inject `window.alert`/`window.confirm` into the daemon's page. After an update the shell starts `tauri::process::current_binary` itself, with a cleaned environment, and exits. It does not call `AppHandle::restart()`, which would pass the old AppImage mount's variables and descriptors on (DESIGN §20.10). Updates are checked and installed from Rust only. No webview gets an updater, dialog or process permission.

## Commands

From `packages/desktop`:

| Command | What |
|---|---|
| `pnpm typecheck` / `pnpm test` | TypeScript only. `test/contract.test.ts` checks the invariants of DESIGN §20.5, the release workflow and the absence of key material on the files as text. `test/prepare-runtime.test.ts` and `test/versions.test.ts` test the runtime script and the version sync |
| `pnpm tauri:dev` | `cargo tauri dev`: a debug build that loads the splash from Tauri's built-in dev server. No runtime, no update check: it uses `PROMPTGRAPH_BIN` or `promptgraph` from `PATH` |
| `pnpm runtime:prepare` | Stages the bundled runtime in `runtime-stage/` (git-ignored): the pinned Node, the server with production dependencies, the web UI and a smoke test (DESIGN §20.6). `--skip-build` reuses the built dists |
| `pnpm tauri:build` | `runtime:prepare`, then `cargo tauri build --bundles deb,appimage --config src-tauri/tauri.bundle.conf.json`: a self-contained app in `src-tauri/target/release/bundle/`, without updater signatures, so it builds without the signing key |
| `node scripts/set-version.mjs X.Y.Z` (repository root) | Sets the one version in every file that carries it (packages, `version.ts`, `Cargo.toml`/`Cargo.lock`, `tauri.conf.json`, the plugin's `plugin.json`) |

The configuration layers: `tauri.conf.json` is what `tauri dev` uses. `tauri.bundle.conf.json` adds the staged runtime as the `runtime/` resource. `tauri.release.conf.json` turns on the updater artifacts (`createUpdaterArtifacts`) and needs the private key, so only the release workflow uses it.

## Environment

| Variable | Effect |
|---|---|
| `PROMPTGRAPH_BIN` | The CLI to run. Nothing is installed and the `promptgraph` command question is not asked. This is the development workflow: `PROMPTGRAPH_BIN=$PWD/../server/dist/cli/index.js pnpm tauri:dev` after `pnpm build`, or a CLI you installed yourself |
| `PG_DESKTOP_DECORATIONS` | `custom`: no native frame, and the tab strip is the title bar. `native`: the window manager's frame. Default: `custom`, or `native` when `WSL_DISTRO_NAME` is set (WSLg) |
| `PG_DESKTOP_ORIGIN` | **Debug builds only**. For example `http://127.0.0.1:5173` rewrites the login URL to the vite dev server, which proxies `/login`, so the web UI hot-reloads inside the shell. Start vite with `PG_DEV_PORT=<daemon port> pnpm --filter @promptgraph/web dev` |
| `PG_DESKTOP_UPDATES` | `0` turns the update check off. Checks run only in release builds with an updater public key, from a `.deb` or from the AppImage that is running |
| `PG_DESKTOP_AUTO_ANSWER` | For testing a release build without a pointer: a comma list `id=key` answers the native questions without showing them, and logs each answer on stderr. Ids and keys: `shim-offer` (`install`, `skip`), `shim-replace` (`keep`, `replace`), `path-warning` (`ok`), `shim-failed` (`ok`), `version-mismatch` (`restart`, `keep`, `use`), `update` (`update`, `later`), `update-failed` (`ok`), `restart-failed` (`ok`). Example: `PG_DESKTOP_AUTO_ANSWER=shim-offer=install,path-warning=ok`. An id may appear twice, the first key that is a button counts: `version-mismatch=keep,version-mismatch=use` answers an older and a newer daemon. A key that is no button is logged, and the question is shown. The splash status lines, the runtime installer's result and the reason of a failed update are logged on stderr as well |
| `XDG_DATA_HOME`, `XDG_CONFIG_HOME` | Where the runtime (`$XDG_DATA_HOME/promptgraph/runtime`, default `~/.local/share`) and the app's preferences (`$XDG_CONFIG_HOME/promptgraph/desktop.json`, default `~/.config`) live |
| `PG_HOME`, `PG_PORT_DEFAULT` | The daemon's state directory and port, as for the CLI. Use a scratch `PG_HOME` and `PG_PORT_DEFAULT=0` when testing |

`PG_DESKTOP_AUTO_ANSWER` and `PG_DESKTOP_UPDATES` are removed from the environment of the CLI and the daemon, with the AppImage, GTK and WebKit variables.

## Signing keys

Updates are signed with a minisign key pair. The public key is in `tauri.conf.json` and is compiled into the app. The private key signs the release artifacts in CI. The maintainer runs these steps once, on their own machine. **Never commit the private key.** `.gitignore` ignores `*.key`, and the contract test fails if any file of the repository contains a private key, in plain text or base64.

1. Generate the pair and choose a password:
   ```sh
   cargo tauri signer generate -w ~/.tauri/promptgraph.key
   ```
   This writes `~/.tauri/promptgraph.key` (the private key, mode 0600) and `~/.tauri/promptgraph.key.pub`. Keep the key only under `~/.tauri/`, never inside a checkout.
2. Paste the **contents** of `~/.tauri/promptgraph.key.pub` (one base64 line) into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` and commit it. The public key is public. While it is `""`, the app checks for no updates and a tag run of the release workflow fails.
3. Create the protected environment and the tag ruleset (next section). Then store the key and its password as **environment** secrets of `desktop-release`, never as repository secrets:
   ```sh
   gh secret set TAURI_SIGNING_PRIVATE_KEY --env desktop-release --repo luisMDev/promptgraph < ~/.tauri/promptgraph.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env desktop-release --repo luisMDev/promptgraph
   ```
   The second command prompts for the password, so it never appears on a command line or in the shell history.
4. Back up the key file and the password outside the machine, for example in a password manager. If you lose either one, installed apps can never update again: a new key needs every user to reinstall by hand.

**Rotation.** Generate a new pair. Ship one release signed with the **old** key whose `pubkey` is the **new** one. Then replace the two environment secrets with the new key and password. Apps that skip that release need a manual reinstall.

## Protecting the release

The signing key is reachable only from the `release` job, which runs in the `desktop-release` environment. The `build` job, which runs `pnpm install`, node-gyp and the tests, has no secret and a read-only token. The maintainer sets the protection up once (DESIGN §20.11). The repository is public, so required reviewers and tag deployment rules are free (DESIGN §17 D12; a private repository would need a paid plan for them).

1. The environment, with you as the required reviewer and deployments limited to custom rules:
   ```sh
   uid="$(gh api user --jq .id)"
   gh api -X PUT repos/luisMDev/promptgraph/environments/desktop-release --input - <<EOF
   {
     "reviewers": [{ "type": "User", "id": $uid }],
     "prevent_self_review": false,
     "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
   }
   EOF
   ```
   `prevent_self_review` stays `false`: you push the tag and approve the job yourself.
2. The deployment rule: only tags matching `desktop-v*` may deploy to the environment.
   ```sh
   gh api -X POST repos/luisMDev/promptgraph/environments/desktop-release/deployment-branch-policies -f name='desktop-v*' -f type=tag
   ```
3. A tag ruleset, so that only repository admins (you) can create, move or delete `desktop-v*` tags:
   ```sh
   gh api -X POST repos/luisMDev/promptgraph/rulesets --input - <<'EOF'
   {
     "name": "desktop release tags",
     "target": "tag",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["refs/tags/desktop-v*"], "exclude": [] } },
     "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }],
     "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }]
   }
   EOF
   ```
   Actor 5 is the repository's admin role.
4. Check the result:
   ```sh
   gh api repos/luisMDev/promptgraph/environments/desktop-release --jq '{protection_rules, deployment_branch_policy}'
   gh api repos/luisMDev/promptgraph/environments/desktop-release/deployment-branch-policies --jq '.branch_policies[] | {name, type}'
   gh api repos/luisMDev/promptgraph/rulesets --jq '.[] | {id, name, target, enforcement}'
   gh secret list --env desktop-release --repo luisMDev/promptgraph
   ```

With this in place, a branch push or a manual run never reaches the key, only you can create a `desktop-v*` tag, and every release job waits for your approval.

## Cutting a release

`.github/workflows/release-desktop.yml` has two jobs:

- `build` runs on every tag push and on manual runs. It installs, tests and stages the runtime, then builds unsigned bundles as workflow artifacts. No secret, read-only token.
- `release` runs only for a pushed `desktop-vX.Y.Z` tag, after your approval. It rebuilds from the staged runtime, signs, and uploads the AppImage, the `.deb`, their `.sig` files and `latest.json` to a **draft** release. Installed apps do not see a draft.

The workflow uses no cache, and every action and the Rust toolchain are pinned.

The bundler downloads its AppImage tools while bundling, and appimagetool downloads the AppImage runtime, which becomes the first part of every AppImage. Both jobs therefore run `scripts/appimage-tools.sh` before any bundling, and the `release` job runs it before the signing key is in any environment. The script puts linuxdeploy, AppRun, linuxdeploy-plugin-appimage and the AppImage runtime (tag `20251108` of `AppImage/type2-runtime`) where tauri-cli 2.12.4 looks for them, checks each against a pinned SHA-256, and sets `LDAI_RUNTIME_FILE` so appimagetool uses the pinned runtime. Nothing is downloaded in the signing step. The plugin has only a `continuous` release. When upstream replaces it, the step fails: review the new file, then pin its SHA-256 (`gh api repos/linuxdeploy/linuxdeploy-plugin-appimage/releases` shows each asset's digest). When you bump tauri-cli, compare the script's file names and URLs with the new tauri-bundler's `linux/appimage/linuxdeploy.rs`.

**Before the first tag**, run the workflow once by hand on your branch (**Actions → Release desktop app → Run workflow**, or `gh workflow run release-desktop.yml --ref <branch>`), so the cache-less build is checked without signing anything. Its bundles are attached to the run as artifacts. GitHub offers manual runs only for a workflow file that exists on the default branch: merge the workflow to `main` first (a manual run on any branch works after that). Until then, the local build in [Release build and distribution](#release-build-and-distribution) is the check.

Then, for each release:

1. `node scripts/set-version.mjs X.Y.Z` from the repository root.
2. Commit: `git commit -am "chore: release desktop vX.Y.Z"`.
3. Tag that commit: `git tag desktop-vX.Y.Z`. The tag must equal the version in `tauri.conf.json`, or the `build` job fails.
4. Push the branch and the tag yourself: `git push origin <branch> desktop-vX.Y.Z`.
5. When the `build` job is green, approve the `release` job (**Review deployments**, or `gh run view`).
6. Review the draft release: the assets, the notes and `latest.json`. Then publish it as the latest release. Only then do installed apps see the update. They offer only a version greater than the installed one.

**Bumping the bundled Node.** Change `NODE_VERSION` and `NODE_SHA256` in `scripts/prepare-runtime.mjs` together, in one commit. Copy the hash of `node-v<version>-linux-x64.tar.xz` from that release's `https://nodejs.org/dist/v<version>/SHASUMS256.txt`, and check its signature as described in Node's README. Change `node-version` of `actions/setup-node` in the workflow to the same version, so `pty.node` is compiled against the Node that loads it (the contract test checks that they match). Then run `pnpm runtime:prepare` and the checklist.

### The "latest release" caveat

The app looks for updates at `https://github.com/luisMDev/promptgraph/releases/latest/download/latest.json`. GitHub resolves `latest` to the most recent **published, non-prerelease** release of the whole repository. If you publish any other full release in this repository, uncheck **Set as the latest release** (`make_latest: false`) or mark it as a pre-release. Otherwise update checks get a 404 until the next desktop release. A 404 is harmless: the app logs it and keeps running (DESIGN §17 D10).

## After an update

The updated app starts its own runtime version and takes over from the daemon that is still running the old one:

- If the old daemon is idle, it is restarted on the new version without a question. Paused runs stay paused and can be resumed.
- If it is running steps, the app asks: **Restart now** interrupts them (their runs pause and can be resumed), **Keep** keeps the old daemon until the next start.
- Claude Code sessions that were already open keep the `promptgraph mcp` server they started with, which is the old version. After a restart their promptgraph tools answer with a reconnect message: run `/mcp` in that session and reconnect **promptgraph**. New sessions start the new version through `~/.local/bin/promptgraph`.
- Old runtime directories are removed at a later start, once no daemon or MCP server runs from them.
- The restarted app keeps the variables you started it with (for example `WEBKIT_DISABLE_DMABUF_RENDERER=1`, `GDK_BACKEND=x11` or `PG_DESKTOP_*`), except the ones that point into the old AppImage's mount.
- If the new version cannot be started, the app says so (`restart-failed`) and closes. The update is installed: start the app again.

## Uninstalling

Removing the app does not remove the files it created in your home directory:

1. `promptgraph stop`
2. `promptgraph desktop shim uninstall --json`. It removes `~/.local/bin/promptgraph` only if the app wrote it. Or remove the file yourself after checking that it contains the line `# promptgraph-desktop shim v1`.
3. Remove the app: `sudo apt remove promptgraph`, or delete the AppImage.
4. `rm -rf ~/.local/share/promptgraph/runtime ~/.config/promptgraph/desktop.json`

`~/.promptgraph` holds the daemon's data (runs, sessions, the token) and is shared with the CLI, so it stays. Delete it only if you want to lose that history.

## Manual checklist

These checks cannot run in the default test suite (DESIGN §20.5). Run them on X11, on Wayland and on WSLg after any change to `src-tauri` or to the Tauri pin. Use a scratch `HOME` (or `XDG_DATA_HOME`, `XDG_CONFIG_HOME`), a scratch `PG_HOME` with `PG_PORT_DEFAULT=0`, and scratch repositories. Run them once with a real profile at the end.

### Release build and distribution

Build like the release does, with a throwaway key in a temporary directory (never under the repository):

```sh
t=$(mktemp -d); cargo tauri signer generate -w "$t/test.key" -p test --ci
# A temporary overlay with the test public key; point the endpoint at a local server to test updates.
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1]+"/updater.json",JSON.stringify({plugins:{updater:{pubkey:fs.readFileSync(process.argv[1]+"/test.key.pub","utf8").trim(),endpoints:["http://127.0.0.1:47999/latest.json"],dangerousInsecureTransportProtocol:true}}}))' "$t"
pnpm runtime:prepare
# The pinned AppImage tools, in a scratch cache, as in the workflow.
eval "$(XDG_CACHE_HOME="$t/cache" bash scripts/appimage-tools.sh)"
# linuxdeploy and its plugins extract themselves into $TMPDIR (appimage_extracted_*): keep that inside "$t" too.
mkdir -p "$t/tmp"
TMPDIR="$t/tmp" XDG_CACHE_HOME="$t/cache" TAURI_SIGNING_PRIVATE_KEY="$(cat "$t/test.key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test \
  cargo tauri build --bundles deb,appimage --config src-tauri/tauri.bundle.conf.json --config src-tauri/tauri.release.conf.json --config "$t/updater.json"
```

When the checklist is done, `rm -rf "$t"` removes the key, the cache and the extracted tools. A bundling run without the scratch `XDG_CACHE_HOME` writes the bundler's own, unverified downloads to `~/.cache/tauri`; delete that directory if it exists (`appimage-tools.sh` re-verifies whatever it finds there anyway).

- [ ] **Build**: the `.deb`, the AppImage and their `.sig` files are written. The warm-up `cargo tauri build --no-bundle` with both overlays and no `TAURI_SIGNING_*` succeeds, and the build after it compiles at most `promptgraph-desktop` (DESIGN §17 D11).
- [ ] **D7, native files in the bundle**: in the `.deb` (`dpkg-deb -x`), `usr/lib/promptgraph/runtime/node/bin/node`, `server/node_modules/node-pty/build/Release/pty.node` and `server/node_modules/better-sqlite3/prebuilds/linux-x64.node` are byte-identical to `runtime-stage/`. In the AppImage (`./promptgraph_*.AppImage --appimage-extract`), linuxdeploy rewrites their dynamic section and adds `RUNPATH [$ORIGIN]` (`readelf -d`), which is expected (DESIGN §17 D7): the first run's self-check must still pass.
- [ ] **First run** (AppImage, then `.deb`), with a scratch `HOME`: the splash shows "Installing promptgraph <version>…". `~/.local/share/promptgraph/runtime/<version>-<id>/` exists (mode 0700 on `runtime/`) and `current` points at it. The window lands on Home.
- [ ] **The daemon runs from the stable directory**: `readlink /proc/<daemon pid>/exe` is `~/.local/share/promptgraph/runtime/<version>-<id>/node/bin/node`, and neither its command line nor its environment (`/proc/<pid>/environ`) mentions `/tmp/.mount_` or `APPDIR`. Close the app: the daemon keeps running, `findmnt | grep mount_` shows no mount left, and `promptgraph ls` still answers.
- [ ] **Relative repository argument**: `cd ~/src && ./promptgraph_*.AppImage myrepo` opens `~/src/myrepo`, not a path inside the mount (AppRun changes to `$APPDIR/usr`; the shell uses `OWD`). A `.deb` started the same way from a terminal that an AppImage opened (its `OWD` is inherited) also opens `~/src/myrepo`.
- [ ] **AppImage mount name**: while the AppImage runs, its `APPDIR` is `/tmp/.mount_<first 6 characters of the file name><random>` (for example `/tmp/.mount_promptAbC123`), which the update gate relies on (DESIGN §20.10). Renamed to a name without `promptgraph`, the app logs "no update checks: APPIMAGE is not a promptgraph AppImage".
- [ ] **The `promptgraph` command**: with no `~/.local/bin/promptgraph`, the first start asks. **Install** writes the shim (mode 0755, the marker line, pointing at `runtime/current`), and `~/.local/bin/promptgraph --version` prints the app's version. **Not now** writes nothing, and neither answer is asked again on the next start. With another `promptgraph` there (an npm global, a symlink), the question names it, **Keep the existing one** is the default (also on Escape), and **Replace** keeps it as `promptgraph.bak`.
- [ ] **PATH warning**: with `~/.local/bin` not on the login shell's `PATH`, **Install** is followed by one warning with the exact line for your shell. It is not shown again for this version.
- [ ] **Development is unchanged**: `PROMPTGRAPH_BIN=… pnpm tauri:dev` installs nothing and asks nothing.
- [ ] **Handover**: start an older daemon (`PG_VERSION_OVERRIDE=0.0.1 promptgraph daemon` from a CLI of the old version, or the previous release), then the app. Idle: it is replaced without a question, and `current` switches. With a running step: the question appears, **Keep** keeps it (the page shows the old daemon's UI and `current` does not move), **Restart now** interrupts it and the run can be resumed.
- [ ] **Update, AppImage**: build a second version (`node scripts/set-version.mjs X.Y.Z+1` in a scratch clone) with the same test key, and serve its AppImage and a hand-written `latest.json` (`{version, notes, pub_date, platforms: {"linux-x86_64-appimage": {signature, url}}}`, the `signature` being the `.sig` file's contents) with `python3 -m http.server --bind 127.0.0.1 47999`. About 5 s after the first version starts, it asks. **Update and restart** shows the download progress on the splash, replaces the AppImage file in place, restarts, and the new version takes over the daemon. **Later** is not asked again in that process. A `latest.json` with a wrong signature ends in "The update could not be installed" and the app keeps running. After the update, `findmnt | grep mount_` lists only the new app's mount once the old process has exited, and neither the new app (`/proc/<pid>/environ`, `/proc/<pid>/cwd`) nor the daemon refers to the old mount.
- [ ] **Update, `.deb`**: the same with the `.deb` installed (`sudo apt install ./…`). The update asks for your password (`pkexec`); cancelling it ends in "The update could not be installed" and the app keeps running.
- [ ] **No update checks** in `tauri dev`, in a bare `target/release/promptgraph-desktop`, in an extracted `squashfs-root/AppRun`, with `PG_DESKTOP_UPDATES=0`, and with an empty `pubkey`: each logs one "no update checks: …" line.
- [ ] **D8, native questions**: they appear over the window on X11, Wayland and WSLg, are plain text (no markup), and closing one picks the safe default.
- [ ] **D9, update errors**: an AppImage in a read-only directory, and a `.deb` without `pkexec`, show `update-failed` and keep running.
- [ ] **D10**: with no published desktop release (a 404), the app logs the failed check and keeps running.
- [ ] **D11, release job without Node packages**: in a fresh clone without `node_modules`, with only the extracted `runtime-stage/`, the warm-up and the signed build both succeed.
- [ ] **D12, protection**: the `desktop-release` environment shows the required reviewer and the `desktop-v*` tag rule, its two secrets are environment secrets, and the ruleset is active (the commands under "Protecting the release").

### Window and pages

- [ ] **Start without PATH**: launch from the desktop menu, or as an AppImage from a file manager. The CLI is found (the bundled runtime, or through the login shell: nvm / pnpm / `~/.local/bin`), and the window lands on Home or `/r/<repoId>`. Repeat with `SHELL=/usr/bin/fish`, and with a start-up file that runs `sleep 300 &` (the window still starts at once).
- [ ] **Launch from a terminal**: `promptgraph-desktop` started from a terminal does not stop or take over that terminal.
- [ ] **Splash errors**:
  - with `PROMPTGRAPH_BIN=/nonexistent`, the splash shows "promptgraph CLI not found…";
  - with a start-up file that prints `command not found` for some other tool, a CLI that fails still shows its own stderr, not "CLI not found";
  - `promptgraph-desktop /does/not/exist` and `promptgraph-desktop -h` show the CLI's error about that path;
  - an old CLI without `open --json` shows "promptgraph ≥ … is required";
  - a CLI that fails shows its stderr;
  - each time, **Retry** runs the CLI again;
  - with `PG_DESKTOP_DECORATIONS=custom`, the splash has the native frame (it can be moved and closed) and the frame goes away when the page loads.
- [ ] **D1, shortcuts**: Ctrl+T / Ctrl+W / Ctrl+Shift+T / Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PageUp/PageDown / Ctrl+1–9 reach the page. The Alt fallbacks work too. In a focused terminal, only tab switching is handled.
- [ ] **D2, IPC from the remote page**: the window controls and `relogin` work on the start page and on deep paths (`/r/<id>/runs/<runId>/nodes/<nodeRunId>`, the report) after a reload.
- [ ] **D4, keys the webview keeps**: record any shortcut that WebKitGTK or the window manager takes before the page sees it.
- [ ] **D5, navigation**:
  - links to other origins and `window.open` never open inside the webview;
  - `https:` links open in the system browser;
  - back navigation from the first page never returns to the splash;
  - a page cannot navigate to another loopback port.
- [ ] **Title bar** (custom decorations):
  - dragging the empty strip area moves the window;
  - double-clicking it maximises and restores;
  - dragging a tab does not move the window;
  - edge handles resize on X11, Wayland and WSLg (with `PG_DESKTOP_DECORATIONS=custom`);
  - minimise, maximise/restore (the icon follows the state) and close work;
  - the signed-out screen keeps a title bar: it can be dragged, resized and closed.
- [ ] **Native decorations** (`PG_DESKTOP_DECORATIONS=native`, the WSLg default): there are no window controls, drag regions or edge handles in the page.
- [ ] **Window title**: it follows the active tab.
- [ ] **External links**: PR links in the node card, the inspector, the report and the run history open in the system browser, including with middle-click. `http:` links to other origins are ignored.
- [ ] **D6, external links from the AppImage**: with the AppImage (not the `.deb`), a PR link and a terminal link start the host browser normally (the opener's `xdg-open` inherits the AppImage's `APPDIR`, `LD_LIBRARY_PATH`, `GTK_*`, `GIO_*`). Repeat with the browser already running and not running.
- [ ] **Terminal links**: an `https:` URL printed in a Claude terminal (a PR URL, a sign-in URL) opens in the system browser when activated.
- [ ] **Relogin after `promptgraph token rotate`**: the page signs in again by itself and stays on the same path. If that fails, **Sign in again** appears. If the new page is signed out again (for example the cookie was not kept), it does not loop: **Sign in again** appears at once.
- [ ] **Relogin after `promptgraph stop`**: after about 10 s unreachable, the page restarts the daemon through the CLI and returns to the same path. If the daemon comes back on another port, the window follows it and the old port is refused. If the relogin fails and the daemon is then started by hand on the same port, the page reconnects, and the next outage relogins automatically again.
- [ ] **Close**: closing the window does not stop the daemon or its runs. A second launch opens a second window with its own tabs.
