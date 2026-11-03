# @promptgraph/desktop

A thin Tauri v2 shell for Linux around the promptgraph web UI ([DESIGN §20](../../docs/DESIGN.md#20-desktop-app-tauri-v2-linux)). It is not a backend: the Node daemon stays the only server and the window is one more client of it. The window's title bar is the in-app tab strip.

How it works, in short:

1. `promptgraph-desktop [repo-dir]` opens one window on a bundled splash page ("Starting promptgraph…"). The splash always has the native window frame, so it can be moved and closed even when an error stops the start.
2. Each time the splash finishes loading, the shell runs `$SHELL -ilc 'exec "$0" "$@"' <PROMPTGRAPH_BIN|promptgraph> open --print-url --json [repo-dir]`. The login shell provides the user's `PATH`, and the AppImage/GTK/WebKit variables are removed first. The CLI starts the daemon if needed and prints an `OpenUrlResult` line.
   - That form is used when `$SHELL` is `sh`, `bash`, `zsh`, `dash`, `ash`, `ksh` or `mksh`. With `fish` the script is `exec $argv`. Any other shell (nushell, …) is replaced by `/bin/sh -lc`, which reads `~/.profile`: put the `PATH` for promptgraph there, or set `PROMPTGRAPH_BIN`.
   - The shell runs in its own session (`setsid`). Its output is read as it arrives, so a background job that keeps the pipes open does not hide the CLI's line. Once the CLI has exited and its output was read, or on the 30 s timeout, the whole session is killed, including anything a start-up file started. The daemon is not in it.
   - The repository argument is made absolute first, even when it does not exist, so the CLI never reads it as an option.
3. The shell takes the last JSON line of stdout and checks `v == 1`. It allows `http://127.0.0.1:<port>`, adds an IPC capability for exactly that origin at run time, turns the native frame off when the title bar is custom, and navigates to the one-time login URL. The shell never reads the token or `daemon.json`.
4. Errors show on the splash, and **Retry** reloads it, which runs the CLI again. When the page is signed out or the daemon is unreachable, it calls the `relogin` command. That runs the CLI again with `--next <current path>`.

## Prerequisites

None of this is needed for `pnpm install`, `pnpm build`, `pnpm typecheck` or `pnpm test`. This package has no `build` script, and its tests read the Rust and JSON files as text.

- Rust stable (`rustup default stable`)
- Tauri's Linux prerequisites:
  ```sh
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- The Tauri CLI, from cargo and not npm: `cargo install tauri-cli --version "^2"`
- On WSL, the window needs WSLg (Windows 11, or Windows 10 with WSLg installed).
- The promptgraph CLI must be on the `PATH` of your login shell, or set `PROMPTGRAPH_BIN=/abs/path/to/promptgraph`.

## Pinned Tauri version

`src-tauri/Cargo.toml` pins **`tauri = "~2.12"`**, plus `tauri-plugin-opener = "2"`, `tauri-build = "2"` and `libc = "0.2"` (for `setsid` and `kill`). The shell needs these APIs:

- `WebviewWindowBuilder::on_new_window` and `NewWindowResponse`, available since 2.8;
- `Manager::add_capability` with `ipc::CapabilityBuilder`, from the default `dynamic-acl` feature;
- `on_navigation`, `on_page_load`, `initialization_script` and `WebviewWindow::set_decorations`.

To move to a newer minor, change the pin, rebuild, and run the checklist below again.

## Commands

From `packages/desktop`:

| Command | What |
|---|---|
| `pnpm typecheck` / `pnpm test` | TypeScript only: `test/contract.test.ts` checks the invariants of DESIGN §20.5 on the files as text |
| `pnpm tauri:dev` | `cargo tauri dev`: a debug build that loads the splash from Tauri's built-in dev server |
| `pnpm tauri:build` | `cargo tauri build --bundles deb,appimage`: bundles are written to `src-tauri/target/release/bundle/` |

Environment:

| Variable | Effect |
|---|---|
| `PROMPTGRAPH_BIN` | The CLI to run, instead of `promptgraph` from the login shell's `PATH` |
| `PG_DESKTOP_DECORATIONS` | `custom`: no native frame, and the tab strip is the title bar. `native`: the window manager's frame. Default: `custom`, or `native` when `WSL_DISTRO_NAME` is set (WSLg) |
| `PG_DESKTOP_ORIGIN` | **Debug builds only**. For example `http://127.0.0.1:5173` rewrites the login URL to the vite dev server, which proxies `/login`, so the web UI hot-reloads inside the shell. Start vite with `PG_DEV_PORT=<daemon port> pnpm --filter @promptgraph/web dev` |

## Manual checklist

These checks cannot run in the default test suite (DESIGN §20.5). Run them on X11, on Wayland and on WSLg after any change to `src-tauri` or to the Tauri pin. Use a scratch `PG_HOME` and scratch repositories, then a real profile once.

- [ ] **Build**: `pnpm tauri:build` produces a `.deb` and an AppImage, and both install and start.
- [ ] **Start without PATH**: launch from the desktop menu, or as an AppImage from a file manager. The CLI is found through the login shell (nvm / pnpm / `~/.local/bin`), and the window lands on Home or `/r/<repoId>`. Repeat with `SHELL=/usr/bin/fish`, and with a start-up file that runs `sleep 300 &` (the window still starts at once).
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
- [ ] **Terminal links**: an `https:` URL printed in a Claude terminal (a PR URL, a sign-in URL) opens in the system browser when activated.
- [ ] **Relogin after `promptgraph token rotate`**: the page signs in again by itself and stays on the same path. If that fails, **Sign in again** appears. If the new page is signed out again (for example the cookie was not kept), it does not loop: **Sign in again** appears at once.
- [ ] **Relogin after `promptgraph stop`**: after about 10 s unreachable, the page restarts the daemon through the CLI and returns to the same path. If the daemon comes back on another port, the window follows it and the old port is refused. If the relogin fails and the daemon is then started by hand on the same port, the page reconnects, and the next outage relogins automatically again.
- [ ] **Close**: closing the window does not stop the daemon or its runs. A second launch opens a second window with its own tabs.
