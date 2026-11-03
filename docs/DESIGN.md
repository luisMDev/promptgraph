# promptgraph — Design Document

> Status: M0–M9 implemented (M7 daemon §4, M8 multi-repo UI with tabs §13, M9 desktop app §20; the desktop shell's Rust side is not yet built or run, §20.5) · Scope: Phase 0–1 (Core), Phase 2 (Control flow) · Audience: personal use (single user, Linux/WSL)

`promptgraph` is a local tool that runs as one background **daemon** per user, bound to `127.0.0.1`, managing any number of git repositories. It is started from the terminal (`promptgraph [repo-dir]` registers a repository and opens it) and serves a React UI that runs in the browser or in a small desktop window (Tauri, §20). In it you draw a flow diagram where each box is a step (a Claude Code prompt, a slash command, a shell command, a commit, a PR…), run it, and watch each box progress in real time. Clicking a box opens the **real, interactive Claude Code terminal** of that step. Graphs, runs and terminals of different repositories can be open side by side in in-app tabs (§13.4).

---

## 1. Goals and non-goals

### Goals

- Define pipelines of Claude Code work as a **directed graph** and run them unattended.
- Run independent branches **in parallel**, each isolated in its own **git worktree**.
- First-class **git steps**: commit, push + PR, merge of parallel branches.
- **Live visibility**: per-node status on the canvas and a real terminal (xterm.js attached to the Claude Code PTY) where you can watch and type.
- **Human-in-the-loop**: approval gates (mandatory before anything leaves the machine) and nodes that pause when Claude needs input.
- **Control flow** (Phase 2): conditional branches, failure routing and bounded loops (e.g. *review → fix → review*, max 3).

### Non-goals

- Multi-user, accounts, remote hosting. It binds to `127.0.0.1` only; the only credential is a local per-user token the user never has to see (§14).
- Windows/macOS support. Linux and WSL only.
- Reusable flow libraries, context templating language, export to Claude Code workflows (explicitly out of scope).
- Replacing Claude Code's own subagents/workflows. Each node is a full Claude Code session; orchestration happens outside.

---

## 2. Phases

| Phase | Name | Content |
|---|---|---|
| **0–1** | **Core** | CLI + server + UI, graph editor, DAG engine, PTY runner with hooks, live terminal, parallel lanes with worktrees, merge node, git nodes, approval gates, run history, resume/retry |
| **2** | **Control flow** | Edge conditions (success/failure), condition node (exit code / LLM judge / regex), dead-path elimination and join policies, bounded loops |

Phase 0 (the original "list of prompts run one after another") is **not a separate product**: it is milestone M1 of the Core phase — a linear graph drawn on the same canvas, executed by the same engine. The data model and engine are designed from day one to support Phase 2 without a rewrite (see §8.1).

---

## 3. Architecture

```
┌──── Browser tab  or  desktop window (Tauri webview, §20), both on http://127.0.0.1:<port> ────┐
│ React + Vite: tab strip (§13.4) ─ one view per tab: Home │ Graph editor │ Run │ Report        │
│  ├─ Canvas (@xyflow/react)      ├─ Inspector (node config)                                     │
│  ├─ Run view (live statuses)    ├─ Terminal drawer (xterm.js, one per node)                    │
│  └─ Approval dialog (diff)      └─ Run history                                                 │
└───────────────▲───────────────────────────────▲──────────────────────────────────────────────┘
                │ REST /api/repos/:repoId/…      │ one WebSocket (repo subscriptions, PTY I/O)
┌───────────────┴───────────────────────────────┴──────────────────────────────────────────────┐
│ promptgraph daemon (Node, Hono + ws), one per user (PG_HOME)                                 │
│  DaemonContext: token · Store (SQLite ~/.promptgraph/state.db) · EventBus · PtyManager        │
│                 HookRouter (POST /hooks/:nodeRunId/:event) · ClaudeRunner · Notifier · WsHub  │
│  RepoRegistry ── RepoContext per registered repository (created lazily, disposed on remove):  │
│     ├─ Graph store ── <repo>/.promptgraph/graphs/*.json (+ file watcher)                      │
│     ├─ Engine ─────── scheduler, state machine, activation tokens                             │
│     ├─ Workspaces ─── git worktree lanes, checkpoints, merges (repo git lock)                 │
│     └─ Runners ────── ShellRunner · GitRunner · Claude (shared ClaudeRunner)                  │
└───────────────┬──────────────────────────────────────────────────────────────────────────────┘
                │ spawn (PTY)                          ▲ curl (hook scripts)
        ┌───────┴──────────┐                           │
        │ claude (interactive) in worktree  ───────────┘
        │ --session-id --settings(hooks) --permission-mode …
        └──────────────────┘
```

Clients of the daemon: the web UI, the CLI (`promptgraph ls`, `open`, …, §4), `promptgraph mcp` (§19) and the desktop shell (§20). They find it through the daemon record (§11.3).

### 3.1 Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node 22, TypeScript, pnpm workspace | `node-pty` and the Agent ecosystem are Node-native |
| Server | Hono + `ws` | Small, typed, easy WebSocket upgrade |
| PTY | `node-pty` | Real TTY so Claude Code runs its interactive TUI |
| DB | `better-sqlite3` | Synchronous, zero-config, crash-safe enough for one user |
| Validation | `zod` | Single schema for graph files, API and WS messages |
| UI | React 19, Vite, `@xyflow/react`, `@xterm/xterm` (+ fit, web-links addons), `zustand`, Tailwind v4, shadcn/ui (Radix primitives) | Standard; React Flow covers nodes/ports/edges/minimap; shadcn/Radix give accessible dialogs, menus, tabs and form controls (focus trap/restore, keyboard navigation) |
| Routing | Hand-written history router in `packages/web/src/lib/router` (no dependency) | Five routes, and each in-app tab owns a location that is not `window.location`, which generic routers do not model |
| Diff view | `react-diff-view` or `diff2html` | Approval dialog |
| Desktop | Tauri v2 (Rust shell, system WebKitGTK), Linux only | A native window and title bar for the same UI; the backend stays the Node daemon (`node-pty` and `better-sqlite3` cannot move into the webview or Rust) |

### 3.2 Repository layout

```
promptgraph/
  packages/
    shared/   # zod schemas, TS types, WS protocol, web URL builders
    server/   # daemon: engine, runners, store, HTTP/WS, CLI entry (bin: promptgraph), MCP server
    web/      # React app (built assets are served by the daemon)
    desktop/  # Tauri v2 shell: src-tauri (Rust), splash page, contract tests in TypeScript (§20)
  docs/
```

---

## 4. CLI and daemon

```bash
promptgraph [repo-dir] [--port 4777] [--no-open] [--foreground]   # register a repository and open it
promptgraph daemon [--port 4777]                                  # run the daemon in this terminal
promptgraph ls [--json]                                           # daemon status, repositories, attention
promptgraph open [repo-dir|repo-id] [--next <path>] [--print-url] [--json] [--web-port <p>]   # open the UI, signed in
promptgraph rm <repo-dir|repo-id> [--force]                       # forget a repository (alias: close)
promptgraph stop                                                  # stop the daemon
promptgraph token rotate                                          # new token; every window signs in again
promptgraph sessions [--json] | sessions revoke <id>|--all        # signed-in browsers and desktop windows
promptgraph mcp                                                   # MCP server for Claude Code (§19.2)
```

A subcommand is recognised only as the first argument; a repository directory named like one is passed as `./ls`. Exit codes: 0 success, 1 error (incl. "not running" for `ls`/`stop`/`sessions`, and a version mismatch, §4.1 item 4), 2 usage, 3 (`daemon` only) another daemon holds the lock.

### 4.1 The daemon

One daemon per user (per `PG_HOME`) manages every repository. It is the only process that writes the state DB.

1. **Start** (`promptgraph daemon`, `--foreground`, or detached by `ensureDaemon`, item 4), in this order: take the daemon lock (below; held → exit code 3) → refuse while a legacy per-repo server is alive (§4.4) → load or create the token (§14) → open `state.db` and migrate (migrations are additive, so a start that fails later leaves only an upgraded DB) → build the `DaemonContext` and the HTTP app (it reads the port through a getter) → bind `127.0.0.1` (item 2) → mark interrupted every run left `running` by a previous daemon (§8.6, no repository filter: there is one writer) → backfill repositories once (§4.4) → take the legacy locks of the registered repositories (§4.4) → start the notifier and the WebSocket hub → write the `port` file and the daemon record (§11.3) → install the process handlers (item 8). Once ready it prints one line, `Listening: http://127.0.0.1:<port> (pid <pid>, promptgraph <version>)`.
   - **The lock is held by the kernel**, not by a pid file: the daemon listens on the Linux abstract Unix socket `\0promptgraph-<uid>-<sha256(realpath PG_HOME)[:16]>`. The kernel releases it when the process dies, so there is no stale lock to take over, no takeover race between concurrent spawners, and no pid-reuse problem after a reboot. `locks/daemon.pid` is written next to it for messages only (`promptgraph daemon is already running (pid N)`).
2. **Port**: an explicit `--port` must be free (else exit 1, `Port <p> is already in use`). Without one, the daemon tries in order the **sticky port** from `<PG_HOME>/port` (the last port it bound), then `PG_PORT_DEFAULT` or 4777, then a random free port, and writes the port it got to `<PG_HOME>/port`. The port is sticky because everything the browser stores (tabs, last graphs, theme) is per origin, and the origin includes the port. Clients never assume 4777: they read the record.
3. **Identity before credentials.** A client never sends the token to whatever answers on the recorded port: loopback ports are shared by every user of the machine, the daemon may have died and the token is long-lived. It first calls `GET /api/daemon/hello?nonce=<16 random bytes, base64url>` (no credentials) and checks that the answer's `proof` equals `HMAC-SHA256(token, "hello:" + nonce)` and that its `pid` is the record's. A record is **stale** when its pid is dead, when the start time of that pid (`/proc/<pid>/stat` field 22) differs from the record's `pidStart`, or when the proof fails; stale records are ignored (and removed by the next daemon start).
4. **Detached start** (`ensureDaemon`, shared by the CLI and `promptgraph mcp`, and through the CLI by the desktop shell): a verified record is reused. If its `serverVersion` differs from the client's version, every command except `ls` and `stop` fails with `promptgraph <old> is running (this is <new>); run promptgraph stop, then retry` (exit 1; MCP tools return the same text). Otherwise it spawns `<node> <cli> daemon` detached, forwarding `--port` **only when the user gave one** (so the daemon keeps its port fallback), with cwd `PG_HOME`, the daemon environment of item 5, and output appended to `~/.promptgraph/logs/daemon.log`, then polls for a verified record for up to 20 s. If the child exits with code 3, another spawner won the lock and the client keeps polling; any other exit before the record is ready, or the timeout, is an error that quotes the last 20 lines of the log.
5. **Environment.** The daemon's environment is what every Claude, shell, git and `gh` child of **every** repository inherits (§7.1), so a detached daemon does not inherit its spawner's environment (often Claude Code in another repository, a shell with direnv secrets, or a desktop launcher without the user's `PATH`). `ensureDaemon` builds it from an allowlist of the caller's variables (`HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TERM`, `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_*`, `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK`, `WSL_DISTRO_NAME`, `WSL_INTEROP`, `WSLENV`, `CLAUDE_CONFIG_DIR` (so its Claude children, transcripts and trust use the caller's Claude config), `PG_*` except a node run's hook variables `PG_PORT`, `PG_HOOK_HEADER_FILE` and `PG_NODE_RUN_ID`, which a daemon started from inside a run would otherwise hand to every child) merged with the environment of the user's login shell (`$SHELL -ilc` printing its environment as JSON, 10 s timeout, the way editors resolve the shell environment; skipped with `PG_DAEMON_SHELL_ENV=0`, which tests use, falling back to the caller's `PATH`), then removes `LD_LIBRARY_PATH`, `LD_PRELOAD`, `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`, `GTK_*`, `GDK_*`, `GIO_*`, `GSETTINGS_*`, `WEBKIT_*` and the Claude nesting variables. A foreground daemon (`daemon`, `--foreground`) keeps its terminal's environment, which the user chose. The daemon checks prerequisites (`git`, `claude`, `gh`, `curl`) against its own environment and reports them as `warnings` in `GET /api/daemon`. There is no per-repository environment: a variable a repository's nodes need belongs in the login shell profile (or is set by its shell nodes); after changing the profile, `promptgraph stop` and start again.
6. **Lifetime**: no idle timeout. Runs outlive terminals, Claude sessions and windows; the daemon stops only with `promptgraph stop`, SIGINT/SIGTERM, or (foreground) SIGHUP when its terminal closes.
7. **Stop** (SIGINT/SIGTERM/SIGHUP): every repository's engine shuts down concurrently (Claude PTYs get `/exit`, ≤5 s, then are killed; running node runs → `interrupted`, runs → `paused`, resumable, §8.6), then the remaining PTYs are killed, the record and the legacy locks are removed, WS/HTTP/DB close and the lock socket closes.
8. **One repository cannot take the others down.** Activating a repository (§4.2) is isolated: a failure (unreadable directory, git error) is reported for that repository (`RepoSummary.error`, 409/500 on its routes) and retried on the next trigger. A graph watcher that cannot start or stops (inotify limit) is reported in `RepoSummary.error` too, but does not fail the activation: the repository keeps working without live reloads of external edits. The graph watcher has an `error` listener (an `FSWatcher` error without one would throw). `unhandledRejection` is logged and the daemon keeps running; `uncaughtException` is logged, then the daemon stops gracefully (item 7, so runs stay resumable) and exits 1.
9. **Log**: `logs/daemon.log` is renamed to `daemon.log.1` when it is larger than 5 MB (one old file is kept), by `ensureDaemon` just before it spawns a detached daemon: the spawner opens the file and hands the daemon its descriptor, so a daemon rotating at its own start would rename the file it is writing to.

### 4.2 Repositories

- **`promptgraph [repo-dir]`** resolves `repo-dir` (default `cwd`) to the git top level and its realpath (fails if not a git repo), checks prerequisites (only warns, `gh` is needed for PR nodes), runs `ensureDaemon`, registers the repository (`POST /api/repos`, idempotent), opens the browser **signed in** on `/r/<repoId>` through a one-time login URL (§14), prints `Opened <name>: http://127.0.0.1:<port>/r/<repoId>` (no secret in it) and exits. `--no-open` registers and prints only. `--port` only applies when this call starts the daemon (a warning says so otherwise).
- **`--foreground`** runs the daemon in this process instead (refused while another daemon runs), registers the repository, opens it and prints `Open: http://127.0.0.1:<port>/r/<repoId>`; Ctrl-C (or closing the terminal) stops the daemon and with it every repository. Tests, crash tests and the screenshot/video scripts use this form.
- **Paths**: `POST /api/repos` takes an **absolute** path; a leading `~` or `~/` is expanded to the daemon user's home, anything else relative is refused with 422 `path_not_absolute` (the daemon's cwd is `PG_HOME`, so a relative path would mean nothing useful). The CLI and `promptgraph mcp` resolve paths before sending them; Home's add field says so.
- **Repository id** (`repoId`, used in every URL and API path): `<slug>-<hash8>`, where `slug` is the directory name lowercased with runs of other characters than `[a-z0-9]` replaced by `-`, trimmed, at most 24 characters (`repo` if empty), and `hash8` the first 8 hex digits of the SHA-256 of the realpath. Readable (`/r/promptgraph-3f9a1c2e`), stable across restarts and re-registration, and distinct for two checkouts with the same name. Only the daemon derives it; clients get it from `POST /api/repos`. Two paths that resolve to the same realpath are the same repository, so two engines never race on one repository's git lock. The registry, the engine (`RepoRef.path`) and `runs.repo_path` all hold that realpath (§4.4 normalises older rows).
- **Registered repositories persist** (table `repos`, §11.2) until removed. A repository whose directory has disappeared stays listed with `available: false`; it is never removed automatically.
- **Loading vs activation.** Any request for a registered repository **loads** its `RepoContext` (graph store, lane manager, runners, engine) without side effects: it reads graph files and the DB, never writes into the repository and runs no git command beyond read-only ones (with `-c core.fsmonitor=false`, §14). **Activation** — create `.promptgraph/graphs/` if missing, start the graph watcher, `git worktree prune`, prune snapshot refs (§9.6, §9.7) — happens only on `POST /api/repos`, a `repo:subscribe` on the WebSocket, or the first mutating (non-GET) request under `/api/repos/:repoId`; never on a GET, so a cross-site `<img>` cannot make the daemon touch a repository (§14). Loading and activation are memoised per repository (two concurrent first requests build one context), a failure clears the memo and is reported in `RepoSummary.error`. Inactive repositories cost a DB row; Home's counters come from the DB. Contexts stay loaded until the repository is removed or the daemon stops.
- **`promptgraph rm <repo>`** (`DELETE /api/repos/:repoId`) is refused with 409 `repo_active` while the repository has a `running` run; `--force` shuts its engine down as in a daemon stop first. Disposing a context unsubscribes its PTY input listener, stops its watcher, shuts its engine down (killing only its own PTYs) and waits for its execution chains to finish, with no timeout, before the row is deleted, its legacy lock released and `repo:removed` sent; while a repository is disposing, requests and re-registration for it wait for the dispose. Removing never loads or activates the repository (an unavailable one, or one whose activation fails, can always be removed) and never deletes graph files, runs, worktrees or branches: re-adding the same path gives the same id and its history back.

### 4.3 Other commands

- **`ls`**: daemon pid, version, port and uptime, then one line per repository (name, id, path, active runs, waiting for approval, waiting for input, unavailable, activation error). `--json` prints `ListReposResponse` (§12.1). Without a daemon it prints `promptgraph is not running` (exit 1); it never starts one. With a daemon of another version it still lists and prints the mismatch on stderr.
- **`open [repo]`**: `ensureDaemon`, registers the repository if one is given, mints a one-time login code and opens `/login?code=…&next=/r/<repoId>` (or Home without an argument), then prints `Opened <name>: <origin><path>`. `repo` (also for `rm`) is a repository id when it has the id shape and the daemon knows it, otherwise a directory (`./name` is always a directory, ids contain no slash). `--next <path>` replaces the target path (a path starting with a single `/`, else exit 2). `--print-url` prints that URL instead of opening a browser; `--json` (which implies `--print-url`: no browser opens) prints `OpenUrlResult {v: 1, cliVersion, url, port, repoId}` on one line and nothing else on stdout: the desktop shell's only interface to the CLI (§20), so the session its URL creates is labelled "promptgraph desktop". `port` is the port of the URL's origin (the web port with `--web-port`), the origin the shell allows. `--web-port <p>` (development) builds the URL on `http://127.0.0.1:<p>`, the vite dev server, which proxies `/login` (§14). The code is valid once, for 30 s.
- **`stop`**: checks the record's identity (pid alive with the recorded start time), sends SIGTERM and waits up to 30 s for the process to exit, printing progress; a stale record is removed and reported as "not running". It never signals a process whose start time does not match.
- **`token rotate`**: with a running daemon `POST /api/daemon/token/rotate` (the daemon swaps the token in memory, rewrites the file, drops every session and closes every WebSocket); otherwise it takes the daemon lock while it rewrites the file, so a daemon starting at the same moment cannot load the old value (lock held but no verified daemon → error, retry); the sessions are deleted by the next daemon start, which finds a token other than the one recorded in `meta` (§14). Every browser and desktop window must sign in again; Claude sessions in flight are not affected (§14).
- **`sessions`**: lists the browser and desktop sessions (§14: id prefix, label, created, last seen; `--json` prints `ListSessionsResponse`); `sessions revoke <id>` ends one (an id that matches no session is an error), `--all` every one. Bearer-only routes, so only a local client with the token can call them.

### 4.4 Upgrading from per-repository servers

Before M7 each repository had its own server (`servers/<repo-key>.json`, `locks/<repo-key>.pid`, `logs/server-<repo-key>.log`).

- The daemon refuses to start while such a record names a live process (`stop the promptgraph server for <repo> (pid <n>) first`), because it would interrupt that server's runs, and deletes stale legacy records. The record has no process start time, so a pid reused by another process (typically after a reboot) is recognised when that process started well after the record's `startedAt` and its command line does not mention promptgraph; when in doubt the record counts as live.
- **The daemon owns the legacy locks.** An old binary started while the daemon runs (an old global install, an outdated `PROMPTGRAPH_BIN`) would open the same `state.db` (it migrates only up to the versions it knows, so it starts normally), interrupt the daemon's runs of its repository and race on its worktrees. Old binaries take `locks/<repo-key>.pid` before they open the DB, so the daemon writes that file with its own pid for every registered repository (at start, on registration and again before each activation) and removes it on `rm` and stop: an old binary then fails with its existing "already running" error. When a live old server already holds it, registration fails with 409 `legacy_server_running` and activation fails (the repository stays inactive) until that server is stopped. `config/repo-key.ts` stays for this.
- The state DB needs no data migration: runs are already keyed by `repo_path`. Migration 3 adds the `repos`, `sessions` and `meta` tables. **Backfill** runs at daemon start until it has committed once: in one transaction it rewrites `runs.repo_path` and `graph_meta.repo_path` to their realpath where that differs and exists, inserts a `repos` row for every distinct `runs.repo_path` that is still a git top level, and sets `meta.repos_backfilled = 1`. It is idempotent and recorded in the DB, so a crash before the commit only retries it, and a repository removed later with `rm` is not brought back.

---

## 5. Core concepts

| Concept | Definition |
|---|---|
| **Graph** | A versioned JSON file in the repo: nodes + edges + settings. Editable only when no run is active on it. |
| **Node** | A step. Has a `type`, a config, input/output ports. |
| **Edge** | Connects an output port to an input port. In Phase 2 it can carry a condition and be a loop back-edge. |
| **Run** | One execution of a graph. Stores an immutable **snapshot** of the graph at start time. |
| **NodeRun** | One execution of a node within a run (Phase 2: one per loop iteration). Has status, timestamps, output, session id, lane. |
| **Lane** | An isolated workspace: one git worktree + one branch. Nodes on a linear path share a lane; fan-out creates new lanes; merge nodes join them. |
| **Session** | A Claude Code conversation (`session_id` UUID). Persisted by Claude Code on disk; can be resumed. |

---

## 6. Graph file format

Stored at `.promptgraph/graphs/<slug>.json`. Committable, diffable. Layout positions live in the same file (they're harmless in diffs and avoid a second file).

```ts
type Graph = {
  version: 1;
  id: string;                 // slug
  name: string;
  settings: GraphSettings;
  nodes: Node[];
  edges: Edge[];
};

type GraphSettings = {
  baseBranch: string;               // e.g. "main"; lanes branch off this
  branchPrefix: string;             // default "pg/<graph-id>"
  maxParallelClaude: number;        // default 3
  workspaceSetup?: string;          // shell run once per new worktree, e.g. "pnpm install"
  defaults: {
    model?: string;                 // "opus" | "sonnet" | full id
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    permissionMode: "acceptEdits" | "auto" | "manual" | "dontAsk" | "plan"; // default "acceptEdits"
    allowedTools?: string[];
    completion: CompletionPolicy;   // see §7.4
  };
  keepWorktrees: "never" | "on-failure" | "always";   // default "on-failure"
};

type Node = {
  id: string;
  type: NodeType;
  label: string;
  position: { x: number; y: number };
  config: NodeConfig;               // discriminated by type, §6.1
  onError?: "fail-run" | "pause";   // default "pause" (Phase 2 adds failure edges)
};

type Edge = {
  id: string;
  source: string; sourcePort: string;   // "out" in Phase 1; "true"/"false"/"error" in Phase 2
  target: string; targetPort: string;   // "in"
  // Phase 2:
  when?: "success" | "failure" | "always";   // default "success"
  loop?: { maxIterations: number; onExhausted: "fail" | "continue" };
};
```

Roots are nodes with no incoming (non-loop) edges. A graph may have several roots (they start in parallel).

### 6.1 Node types (Phase 1)

| Type | Runner | Config | Output |
|---|---|---|---|
| `prompt` | Claude (PTY) | `prompt`, `context`, `model?`, `effort?`, `permissionMode?`, `allowedTools?`, `completion?` | Last assistant message |
| `command` | Claude (PTY) | `command` (e.g. `/simplify`, `/code-review high`), plus same options as `prompt` | Last assistant message |
| `shell` | Shell (PTY) | `run`, `timeoutSec?`, `env?` | Exit code + tail of stdout/stderr (last 200 lines) |
| `commit` | Git | `message?` (fixed) or `generateMessage: true` (default), `squashCheckpoints: true` (§9.3) | Commit SHA, message |
| `pr` | Git + `gh` | `title?`/`body?` or generated, `draft: true`, `base?` (default `baseBranch`), `requireApproval: true` | PR URL |
| `approval` | — | `message?`, `showDiff: true` | `approved` / `rejected` + comment |
| `merge` | Git (+ Claude on conflict) | `strategy: "merge" \| "squash"`, `onConflict: "claude" \| "pause"` | Merge SHA, conflicted files |

`prompt` and `command` share the same runner; `command` exists so the canvas shows slash-command boxes distinctly and the inspector can offer a picker of the repo's/user's available commands and skills.

**Generated messages** (`commit`, `pr`): the server runs a short headless call, `claude -p --output-format json --json-schema <schema>`, feeding the staged diff stat + the outputs of the nodes since the last commit in that lane. Headless is fine here: there is nothing to watch.

**`pr` always implies `git push`.** With `requireApproval: true` (the default, and the only option exposed in the UI unless explicitly unlocked in graph settings), the node enters `waiting_approval` before pushing.

---

## 7. Claude runner (PTY + hooks)

This is the core technical piece and the main thing the spike (M0 in §16, assumptions in §17) validates.

### 7.1 Spawn

For each `prompt`/`command` NodeRun the server spawns, via `node-pty`, inside the lane's worktree:

```bash
claude "<initial message>" \
  --session-id <uuid>               # generated by us → we know it before start
  --name "pg:<graph>/<node-label>"  # visible in /resume and terminal title
  --settings <run-dir>/hooks.json   # hook injection, §7.2
  --permission-mode <mode> \
  [--model <m>] [--effort <e>] [--allowedTools ...]
```

or, when `context = "resume"` (§7.5): `claude --resume <previous-session-id> "<message>" ...`.

- `cols/rows`: start at 120×40; resized on attach from the browser (`pty.resize`).
- Env: inherits the daemon's environment (§4.1 item 5: the same for every repository, never the environment of whoever registered the repository) minus `PG_HOME` and any inherited hook variables, plus `TERM=xterm-256color`, `PG_PORT` (the daemon's port), `PG_HOOK_HEADER_FILE`, `PG_NODE_RUN_ID`. The token is never passed to Claude: the header file (mode 0600, in the run dir) holds a per-node-run hook token, `HMAC(hook secret, nodeRunId)`, that only authorises `POST /hooks/<nodeRunId>/*`. The hook secret is random per daemon start and kept in memory only (PTYs never outlive the daemon), so rotating the token (§14) does not cut live sessions off.
- `<initial message>` for `command` nodes is the slash command itself (`/simplify`); for `prompt` nodes it is the prompt plus the context block (§7.5).

### 7.2 Hook injection

`hooks.json` (generated once per run) adds hooks on top of the user's own (Claude Code merges settings sources), and the deny rules of §7.6:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "pg-hook session-start" }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "pg-hook stop" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "pg-hook notification" }] }],
    "PreToolUse":   [{ "hooks": [{ "type": "command", "command": "pg-hook activity" }] }]
  }
}
```

`pg-hook` is a tiny script shipped with the server (absolute path written into the JSON):

```sh
#!/bin/sh
# Forwards the hook payload (stdin JSON) to the promptgraph server. Never blocks Claude.
curl -s -m 2 -X POST \
  -H @"$PG_HOOK_HEADER_FILE" -H "Content-Type: application/json" \
  --data-binary @- "http://127.0.0.1:$PG_PORT/hooks/$PG_NODE_RUN_ID/$1" >/dev/null 2>&1
exit 0
```

| Hook | Payload fields used | Effect |
|---|---|---|
| `SessionStart` | `session_id`, `transcript_path` | Confirms the session; node → `running` |
| `PreToolUse` | `tool_name` | Updates "last activity" shown on the node (e.g. `Edit src/app.ts`) |
| `Notification` | `message` | Node → `waiting_input` (permission prompt or idle waiting). Badge + optional desktop notification |
| `Stop` | `session_id`, `transcript_path`, `stop_hook_active` | Claude finished a turn → completion policy (§7.4) |

Activity resets `waiting_input` back to `running` (next `PreToolUse` or PTY input from the user).

### 7.3 Terminal streaming

- The server keeps a **ring buffer** (2 MB) of raw PTY output per NodeRun. Attaching a terminal replays the buffer, then streams live.
- WS messages: `pty:data` (server→client, base64 chunks), `pty:input` (client→server keystrokes), `pty:resize`.
- Multiple viewers allowed; the most recent attach drives the PTY size.
- After the process exits, the buffer is flushed to `~/.promptgraph/runs/<run>/<nodeRun>.log` so finished nodes still show their terminal (read-only), with a button **"Reopen session"** that spawns `claude --resume <session-id>` in a new PTY (not part of the run).

### 7.4 Completion policy

`Stop` fires at the end of **every** turn, including when Claude stops to ask a question. Policy per node:

```ts
type CompletionPolicy =
  | { mode: "auto"; graceSec: number }   // default: graceSec = 5
  | { mode: "manual" }                   // wait for the user to click "Done"
  | { mode: "marker"; token: string };   // done only if last message contains token
```

- **auto**: on `Stop`, start a grace timer. If the user types into the PTY during the grace period, cancel (the user is steering). If the grace expires → node `succeeded`.
- **manual**: node → `idle` (blue, "Claude finished a turn") until you click **Done** or **Fail**.
- **marker**: the prompt gets an appended instruction: *"When the task is fully complete, end your final message with `<token>`. If you need input, ask instead."* On `Stop` the server reads the last assistant message; token present → `succeeded`, otherwise → `idle` (needs you).

A node in the canvas can be toggled to **Hold** at any time while running: it behaves as `manual` for the current turn.

The auto grace period is visible (risk R3): while it runs, the node run carries `graceUntil` (epoch ms when it succeeds) and the UI shows *"Auto-continuing in 5s… [Hold]"* on the node card, in the inspector and in the terminal drawer's tab bar. Hold during the countdown cancels it and the node goes `idle`. `graceUntil` is cleared when the countdown stops (typing, new activity, Hold) and whenever the node leaves `running`.

On success the server sends `/exit` to the PTY, waits 3s, then kills it. The session stays on disk. `/exit` is only typed while Claude sits at its input prompt; when it may be showing a permission or trust dialog (where Enter accepts the default "Yes"), the process gets SIGTERM instead.

### 7.5 Context between nodes

Fixed modes on the target node (no templating language):

| `context` | Behaviour | Valid when |
|---|---|---|
| `fresh` *(default)* | New session. The initial message is prefixed with a **"Context from previous steps"** block containing the outputs of the direct predecessors (truncated to 4k chars each), then the node's prompt | Always |
| `resume` | `claude --resume <predecessor-session-id>`: same conversation, same memory | Exactly one predecessor is a Claude node **in the same lane** |
| `clean` | New session, only the prompt. The repo state is the only context | Always |

Output of a Claude node = text of the **last assistant message**, read from `transcript_path` (JSONL) on `Stop`. Stored in `node_runs.output`.

### 7.6 Permissions

- Default `permissionMode: "acceptEdits"`. `bypassPermissions` is not offered in the UI.
- When a permission prompt appears, `Notification` turns the node yellow; you answer it in the terminal.
- `allowedTools` per node to make unattended runs smoother (e.g. `Bash(pnpm test:*)`).
- The generated `--settings` file (§7.2) also carries `permissions.deny` rules for promptgraph's own secrets: `Read` and `Edit` of `<PG_HOME>/token`, `<PG_HOME>/state.db*`, `<PG_HOME>/runs/**` (the hook header files), `<PG_HOME>/servers/**` (the discovery records of pre-M7 per-repository servers, which hold that server's live API token) and `<PG_HOME>/logs/**` (pre-M7 detached servers printed a token URL to their logs; the daemon logs no credential, but old logs may remain), as absolute rule paths (`//…`). An agent therefore cannot read the token with its file tools and approve its own gate through the API (invariant: nothing leaves the machine without approval). `PG_HOME` is not passed to children. This does not contain shell commands: in the default `acceptEdits` mode a `Bash` command that reads the file needs the user's permission, unless the node's `allowedTools` grants it; shell nodes are trusted graph code (§14).

---

## 8. Execution engine

### 8.1 Model: activation tokens

The engine is **activation-based**, not a one-shot topological sort, so Phase 2 (conditions, loops) is an extension rather than a rewrite:

- When a NodeRun finishes, it emits an **outcome** (`success` | `failure`, Phase 2: plus port `true`/`false`).
- For each outgoing edge whose condition matches the outcome, the engine delivers an **activation** to the target's input; edges that don't match deliver a **skip** (§10.3).
- A node becomes **ready** when every incoming non-loop edge has delivered either an activation or a skip, and at least one is an activation (Phase 1: all are activations).
- Ready nodes enter a queue; the scheduler starts them subject to concurrency limits.

In Phase 1 every edge is `when: success`, so this reduces to "a node runs when all its predecessors have succeeded".

### 8.2 Node states

```
pending ─► ready ─► running ─┬─► succeeded
                    ▲   │    ├─► failed
                    │   ▼    └─► cancelled
                    │ waiting_input / idle / waiting_approval
                    │
           skipped (Phase 2: dead path)     interrupted (server stopped mid-run)
```

| State | Canvas colour |
|---|---|
| pending | grey outline |
| ready / queued | grey filled |
| running | blue, animated border, last activity text |
| idle (turn finished, awaiting Done) | light blue |
| waiting_input | amber, pulsing |
| waiting_approval | violet |
| succeeded | green |
| failed | red |
| skipped | faded, dashed |
| cancelled / interrupted | dark grey |

Edges animate while their source is running and are coloured green once they delivered an activation.

### 8.3 Run states

`running` → `succeeded` | `failed` | `paused` | `cancelled`.
A run is `paused` when a node failed with `onError: "pause"` and no other branch can make progress; you can **retry** the node, **skip** it (treat as success), or **cancel** the run.

### 8.4 Scheduling and limits

- `maxParallelClaude` (default 3) caps concurrent Claude PTYs across the run. `shell`/git nodes are not capped (they are short) except one git write operation per lane at a time.
- Queue order: FIFO by readiness time.
- Rate-limit/usage-limit messages from Claude Code are just terminal text; the node stays `running`/`waiting_input` and you see it. (A later improvement could detect them and back off.)

### 8.5 Failure semantics (Phase 1)

| Node type | Fails when |
|---|---|
| prompt / command | PTY exits unexpectedly before success; user clicks **Fail**; `marker` mode and user marks failed |
| shell | Exit code ≠ 0 or timeout |
| commit | Git error. Nothing to commit → **succeeds** with `output.noop = true` (no empty commit is created) |
| pr | Push/`gh` error, or approval rejected |
| approval | Rejected |
| merge | Unresolved conflicts with `onConflict: "pause"` after you cancel, or the Claude resolver fails |

### 8.6 Resume after crash

When the daemon starts it finds runs (of every repository) with NodeRuns in `running`/`waiting_*` state and marks them `interrupted`, the run `paused`; removing a repository with `--force` does the same for its runs. **Retry** on an interrupted Claude node spawns `claude --resume <session-id>` with the message *"You were interrupted. Continue the task."* (completion policy applies normally).

---

## 9. Workspaces and lanes

### 9.1 Layout

```
~/.promptgraph/worktrees/<repo-name>/<run-id>/<lane-id>/   # git worktree
branches: <branchPrefix>/<run-short-id>/<lane-id>           # e.g. pg/feature-x/3f9a/main
```

Worktrees live outside the repo to avoid polluting it and to avoid nested-repo confusion for tools. Two registered repositories with the same directory name share `<repo-name>/`; run ids keep their worktrees apart.

### 9.2 Lane assignment (computed at run start, on the snapshot)

1. Each root gets a new lane branched from `baseBranch`.
2. A node with **one** successor: the successor stays in the same lane.
3. A node with **N > 1** successors (fan-out): the first successor (by canvas x/y order) keeps the lane; each other successor gets a new lane branched from the parent lane **after a checkpoint**.
4. A `merge` node continues in the lane of its first input (by canvas order) and merges the others into it.
5. Any non-`merge` node with more than one incoming edge is a **validation error** in Phase 1 (to join parallel work you must use `merge`). Phase 2 relaxes this for nodes whose inputs come from mutually exclusive branches.

### 9.3 Checkpoints

Before a fan-out creates new lanes, and before a `merge` reads a lane, the engine makes a checkpoint commit if the lane is dirty:

```
git add -A && git commit -m "pg: checkpoint after <node-label>" --no-verify
```

Checkpoints are regular commits on the lane branch. A later `commit` node with `squashCheckpoints: true` (default) soft-resets to the last non-checkpoint commit before committing, so PRs don't contain "checkpoint" noise.

### 9.4 New-lane setup

When a worktree is created: `git worktree add -b <branch> <path> <from-ref>`, then `settings.workspaceSetup` (e.g. `pnpm install`) runs as a hidden shell step shown as a small badge on the first node of the lane. Failure fails that node.

### 9.5 Merge node

```
git merge --no-ff <other-lane-branch>        # for each other input, in canvas order
```

- On conflict with `onConflict: "claude"`: the merge node spawns a Claude PTY in the lane with *"Resolve the merge conflicts in: <files>. Keep the intent of both branches. Run the tests if available. Then stage the files."* When it succeeds, the engine runs `git commit --no-edit`. You can watch/steer in the terminal like any other node.
- With `onConflict: "pause"`: node → `waiting_input`; the terminal drawer opens a shell in the worktree for you to resolve manually, then click **Done**.

### 9.6 Cleanup

At run end, per `keepWorktrees`: `git worktree remove --force` + delete local branches that were not pushed and hold no commits of their own (or were merged). Pushed branches, and unpushed branches carrying commits (e.g. from a commit node), are kept so no committed work is lost. A **"Clean up"** action in run history does the same on demand. `git worktree prune` runs when a repository is activated in the daemon (§4.2).

### 9.7 Per-node snapshots

To show what each node changed (not only the lane against the base branch), the engine snapshots the lane's worktree right before a node's runner starts (after lane creation, workspace setup and the pr/merge checkpoints) and right after it finishes (before the next node of the lane can start):

```
cp <worktree index> $TMP/index                    # keeps the stat cache: only changed files are hashed
GIT_INDEX_FILE=$TMP/index git add -A && git write-tree
git commit-tree <tree> -p HEAD -m "pg: snapshot <start|end> of <label>"   # fixed identity "promptgraph"
git update-ref refs/promptgraph/<run-id>/<node-run-id>/<start|end> <sha>
```

- HEAD, the lane's index and its branch never change; the snapshots are not checkpoints and never appear in a lane's history. The shas are stored on the node run (`snapshotStart`, `snapshotEnd`).
- The node's diff is `snapshotStart..snapshotEnd` (while it runs: `snapshotStart` → the live worktree). It is computed in the main checkout, so it still works after cleanup.
- A snapshot's parent is the lane's HEAD, so the hidden refs also keep the lane's commits reachable after cleanup deletes the branch: the run report (§13.1) shows a lane's changes and commits from its last end snapshot.
- Snapshots are best effort: a failure is logged (`snapshot.failed`) and only loses that node's diff.
- When a repository is activated in the daemon, the refs of its runs that finished more than 30 days ago (or are unknown) are deleted. They live under `refs/promptgraph/`, so `git branch` does not list them and a normal `git push` does not send them.

---

## 10. Approval gates

- `approval` node: pauses with status `waiting_approval`. The UI shows a dialog with: the message, the lane's diff against `baseBranch` (file list + unified diff), outputs of predecessors, and **Approve / Reject (+ comment)**.
- `pr` node with `requireApproval: true` shows the same dialog, plus the generated title/body editable before pushing.
- Approvals can be given from the canvas (violet node → click), from the "Pending" counter in the header of a repository's views, or from Home, which counts the nodes waiting for approval in every repository (§13.3).

---

## 11. Persistence

### 11.1 Graph files

`.promptgraph/graphs/*.json` in the repo. Saved on every edit (debounced 500ms). Validated with zod on load; invalid files are shown with the error and not runnable.

### 11.2 SQLite (`~/.promptgraph/state.db`)

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY, repo_path TEXT, graph_id TEXT,
  graph_snapshot TEXT NOT NULL,          -- JSON
  status TEXT, started_at INTEGER, finished_at INTEGER
);
CREATE TABLE lanes (
  id TEXT, run_id TEXT, branch TEXT, worktree_path TEXT,
  base_ref TEXT, status TEXT,            -- active | merged | removed
  PRIMARY KEY (run_id, id)
);
CREATE TABLE node_runs (
  id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT,
  iteration INTEGER DEFAULT 0,           -- Phase 2 loops
  lane_id TEXT, status TEXT,
  session_id TEXT, transcript_path TEXT,
  output TEXT,                           -- JSON: { text?, exitCode?, sha?, prUrl?, ... }
  error TEXT, started_at INTEGER, finished_at INTEGER
);
CREATE TABLE events (                    -- append-only log; drives UI replay and debugging
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, node_run_id TEXT,
  type TEXT, payload TEXT, at INTEGER
);
```

Migration 3 (§4.2, §4.4, §14):

```sql
CREATE TABLE repos (                     -- registered repositories
  id TEXT PRIMARY KEY,                   -- repoId, <slug>-<hash8> (§4.2)
  path TEXT NOT NULL UNIQUE,             -- realpath of the git top level; = runs.repo_path
  name TEXT NOT NULL,                    -- directory name, shown in tabs and on Home
  added_at INTEGER NOT NULL, last_opened_at INTEGER
);
CREATE TABLE sessions (                  -- signed-in browsers and desktop windows (§14)
  id_hash TEXT PRIMARY KEY,              -- SHA-256 of the cookie value; the value itself is never stored
  label TEXT NOT NULL,                   -- short user-agent summary ("Firefox", "promptgraph desktop")
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- one-time steps (repos_backfilled), token_fingerprint (§14)
```

`runs` keep `repo_path` (no `repo_id` column): a repository's id is a function of its path, so the join is `repos.path = runs.repo_path` and removing then re-adding a repository finds its runs again.

Terminal logs: `~/.promptgraph/runs/<run-id>/<node-run-id>.log`.

### 11.3 Daemon files (`~/.promptgraph`, directory mode 0700)

| File | Mode | Content |
|---|---|---|
| `token` | 0600 | The persistent token (32 random bytes, base64url), created on first start, replaced by `promptgraph token rotate` (§14) |
| `daemon.json` | 0600 | `DaemonInfo {version: 2, pid, pidStart, port, serverVersion, startedAt}`: written atomically once the daemon is ready, removed on stop. `pidStart` is the process start time (`/proc/<pid>/stat` field 22) so a reused pid is recognised as stale (§4.1 item 3). It holds no secret: clients read `token` separately |
| `port` | 0600 | The last port the daemon bound (the sticky port, §4.1 item 2) |
| `locks/daemon.pid` | 0600 | Pid of the daemon, for messages only; the lock itself is an abstract Unix socket held by the kernel (§4.1 item 1) |
| `locks/<repo-key>.pid` | 0600 | Legacy per-repository locks, written by the daemon for every registered repository so pre-M7 binaries refuse to start (§4.4) |
| `logs/daemon.log` | 0600 | Output of a detached daemon (appended; rotated to `daemon.log.1` above 5 MB at start) |
| `state.db`, `settings.json`, `runs/`, `worktrees/`, `bin/pg-hook` | | As before; `settings.json` (notifications) is global to the daemon |

The daemon re-asserts the modes of the directory, `token` and `state.db` on every start.

---

## 12. Server API

### 12.1 REST

Daemon-level routes:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/daemon/hello?nonce=` | **No credentials.** `{pid, serverVersion, proof}` with `proof = HMAC-SHA256(token, "hello:" + nonce)`: lets a client verify the daemon before it sends the token (§4.1 item 3) |
| GET | `/api/daemon` | `DaemonInfoResponse`: version, pid, port, startedAt, phase, supportedNodeTypes, prerequisite warnings of the daemon's own environment, notificationsAvailable |
| GET | `/api/repos` | `ListReposResponse`: every registered repository with its status (`RepoSummary`, §13.3) |
| POST | `/api/repos` | `{ path }` (absolute, `~` expanded) → `RepoSummary`. Resolves to the git top level and realpath, idempotent, updates `lastOpenedAt`, activates the repository; 422 `path_not_absolute` / `not_a_git_repo` |
| DELETE | `/api/repos/:repoId?force=1` | Forget a repository (§4.2); 409 `repo_active` while it has a running run and `force` is not set |
| GET/PUT | `/api/settings` | App settings (global) |
| POST | `/api/daemon/login-codes` | One-time login code `{ code, expiresAt }` (**Bearer only**, §14); optional body `{ desktop: true }` labels the session it creates "promptgraph desktop" |
| POST | `/api/daemon/token/rotate` | Replace the token, drop every session (**Bearer only**, §14) |
| GET | `/api/daemon/sessions` | `ListSessionsResponse` (**Bearer only**) |
| DELETE | `/api/daemon/sessions/:id` | Revoke one session (id prefix of at least 8 hex digits) or every one (`:id` = `all`) (**Bearer only**) |
| GET | `/login?code=&next=` | Page: redeems a login code, creates a session, sets the cookie, redirects to `next` (§14) |

Repository routes, all under `/api/repos/:repoId` (404 `unknown_repo` for an unregistered id, 409 `repo_unavailable` when its directory is gone; requests for a repository being removed wait for the removal, §4.2). The middleware **loads** the repository's context for every request and **activates** it before any non-GET request (§4.2). Run, node-run and PTY ids are globally unique, but they are still addressed under their repository: the engine answers `not_found` for another repository's ids, so routing needs no lookup and a tab can never act on the wrong repository.

| Method | Path (after `/api/repos/:repoId`) | Purpose |
|---|---|---|
| GET | (the prefix itself) | `RepoInfoResponse`: id, path, name, current branch, branches |
| GET | `/graphs` | List graphs in the repo |
| GET/PUT/DELETE | `/graphs/:id` | Read / save / delete a graph |
| POST | `/graphs/:id/validate` | Validation errors (cycles, invalid joins, missing config) |
| POST | `/graphs/:id/runs` | Start a run |
| GET | `/runs?graph=` | Run history |
| GET | `/runs/:id` | Run + lanes + node runs |
| POST | `/runs/:id/{cancel,cleanup,resume}` | Run controls |
| GET | `/runs/:id/report` | Run report (§13.1) |
| GET | `/runs/:id/lanes/:laneId/diff` | Lane diff vs base, also after cleanup (from snapshots) |
| GET | `/pending` | Node runs waiting for approval in this repository |
| POST | `/node-runs/:id/{done,fail,retry,skip,hold}` | Manual controls |
| GET/POST | `/node-runs/:id/approval` | Approval info / `{ approved, comment, title?, body? }` |
| GET | `/node-runs/:id/diff?scope=lane\|node` | Lane diff vs base (default), or what the node changed (§9.7) |
| POST | `/node-runs/:id/reopen` | Spawn `claude --resume` PTY for a finished node |
| DELETE | `/ptys/:ptyId` | End a reopened session |
| GET | `/commands` | Available slash commands/skills (for the `command` picker) |
| GET | `/claude-setup` | Setup guide for this repository (§19.5) |
| POST | `/claude-setup/check` | Runs `claude mcp get promptgraph` **in the repository** (`cwd` = its path), because MCP servers registered at local or project scope depend on the directory (§19.5) |

Hooks: `POST /hooks/:nodeRunId/:event` stays unscoped. Node run ids are unique across repositories, the `HookRouter` is daemon-wide and keyed by node run id, and the handler registered for that id belongs to the owning repository's execution, so the hook reaches the right engine without naming the repository. `pg-hook` and `hooks.json` are unchanged; `PG_PORT` is the daemon's port.

Every route except `/login`, `/api/daemon/hello` and the hook receiver requires the token (`Authorization: Bearer`) or a session cookie (§14); routes marked Bearer only refuse the cookie with 403 `forbidden_cookie_auth`; hooks accept the node run's hook token.

### 12.2 WebSocket (`/ws`)

One socket per page, whatever the number of tabs and repositories. Run and PTY traffic is already scoped by subscription; repository traffic is scoped by a repository subscription, so a page only receives events of the repositories its tabs show.

```ts
// server → client
{ type: "hello", version }
{ type: "repo:status", repo }                 // RepoSummary; to every client (Home, tab badges), debounced 250 ms per repo
{ type: "repo:removed", repoId }              // to every client
{ type: "run:update", repoId, run }           // to clients subscribed to the repo
{ type: "graphs:changed", repoId, graphId }   // to clients subscribed to the repo
{ type: "node:update", nodeRun }              // to clients subscribed to the run
{ type: "lane:update", lane }                 // to clients subscribed to the run
{ type: "pty:attached" | "pty:data" | "pty:exit" | "pty:error", ptyId, … }   // to clients attached to the pty
// client → server
{ type: "repo:subscribe", repoId }  { type: "repo:unsubscribe", repoId }
{ type: "subscribe", runId }        { type: "unsubscribe", runId }
{ type: "pty:attach", ptyId, cols?, rows? }   // server replies with buffered output first
{ type: "pty:detach", ptyId }
{ type: "pty:input", ptyId, data }
{ type: "pty:resize", ptyId, cols, rows }
```

The client reference-counts its subscriptions (two tabs on one run share one `subscribe`) and re-sends them after a reconnect. `repo:subscribe` activates the repository (§4.2); the upgrade is checked like any request (Host/Origin, session cookie or Bearer; the URL carries no credential). A token rotation, or revoking the socket's session, closes it with code 4401; the client then treats the session as signed out (§13.5).

---

## 13. UI

Every view has a URL (§13.2) and lives in an in-app tab (§13.4). The views are **Home** (§13.3), the **graph editor**, a **run** (the canvas in run mode), a **node run** (a run with one node selected and its terminal open) and the **run report** (§13.1). The graph editor and run views are made of:

- **Header**: repository name (links to Home), graph selector, run selector (live or historical), the repository's pending approvals counter, settings.
- **Canvas** (React Flow): palette on the left (drag node types in), minimap, snap to grid. Floating over its top right corner: a "Saving…" spinner while an edit is being autosaved (nothing once saved; the error if a save fails), the problems button, the run's cost and **Report**, and Resume / Run / Cancel. In run mode the graph is read-only and nodes show status colour, elapsed time, last activity, and lane badge (colour per lane so you can see worktrees at a glance).
- **Inspector** (right): config of the selected node; in run mode, its NodeRun details (output, session id, branch, timings, error) and controls (Done, Fail, Hold, Retry, Skip).
- **Terminal drawer** (bottom, resizable): opens on node click. Its own small tab row, one per open terminal (not to be confused with the app tabs of §13.4). Live PTY for running nodes, replayed log for finished ones with "Reopen session".
- **Approval dialog**: diff viewer + approve/reject.
- **Diff dialog**: what a node changed (§9.7), with a switch to its whole lane; opened from the inspector and the report.
- **Validation**: invalid nodes/edges are outlined red with a tooltip; Run is disabled while there are errors.

### 13.1 Run report

A page that answers "what happened while I was away", at `/r/<repoId>/runs/<runId>/report`. It replaces the run view in its tab until closed (back to the run's URL); it opens from **Report** on the canvas, from each run in the history (both links, so Ctrl-click opens it in a new tab), and by itself when the run shown on the canvas of the active tab finishes. It follows the run live.

- **Summary**: result, duration, total time spent waiting for the user, estimated cost, step counts, the run error.
- **Where it stopped or waited**: unhandled failures, interruptions, cancellations and steps waiting for the user now; then waits of at least a minute, longest first. Waiting time is the time a node run spent in `idle`, `waiting_input` or `waiting_approval`, from the `node.status` events.
- **Steps**: one row per (node, iteration), latest attempt: result, attempts, duration, waited, what it changed (opens its diff), cost, and its output (commit, PR, approval, branch taken, error).
- **Pull requests** and **lanes**: per lane its branch, state, changes and commits since the base branch (checkpoints marked), and its diff.

![The run report of a fan-out run that opened a pull request](screenshots/run-report.png)

### 13.2 URLs and navigation

The web app has a small router of its own (`lib/router`, no dependency). The URL shapes are fixed in `packages/shared/src/urls.ts` (`webRoutes`), so the CLI, `promptgraph mcp` and the desktop shell build the same links the web parses:

| Path | View |
|---|---|
| `/` | Home |
| `/r/:repoId` | Redirects (replace) to the repository's last graph (`localStorage` `pg.lastGraph.<repoId>`), else its first graph, else an empty state with "New graph" |
| `/r/:repoId/graphs/:graphId` | Graph editor |
| `/r/:repoId/runs/:runId` | Run (canvas in run mode, history of its graph on the left) |
| `/r/:repoId/runs/:runId/nodes/:nodeRunId` | Run with that node run selected and its terminal open in the drawer |
| `/r/:repoId/runs/:runId/report` | Run report (§13.1) |
| `/login?code=&next=` | Served by the daemon, never by the router (§14) |

- The route is the source of truth: stores follow the location of their tab (graph opened, run selected and subscribed, node selected). Selecting a graph, a run, a node on the run canvas (replacing the history entry within the same run) or the report navigates; starting a run navigates to it; leaving run mode navigates to the graph. A graph route whose graph has an active run stays on the (read-only) graph with a "View live run" link. Selection inside the graph editor is not in the URL.
- Every in-app navigation target is a real `<a href>` (`<Link>`): a plain click navigates the current tab, Ctrl/Cmd-click or middle-click opens a background tab, Ctrl/Cmd+Shift-click a foreground tab. Run history rows, the run selector, the graph selector, the pending list (a plain click also opens the approval dialog), banners and Home's rows are links.
- The window URL mirrors the active tab: navigating inside it pushes a history entry `{tabId, path}`, switching tabs replaces the entry. Back/forward (`popstate`) re-applies the entry to its tab (activating it); an entry whose tab has been closed is skipped (the window URL is put back to the active tab's path with `replaceState`), so it never overwrites an unrelated tab. Reloading the page restores the window's tabs (§13.4).
- Links to other origins (pull requests, docs) are plain `<a target="_blank" rel="noopener noreferrer">` in a browser. In the desktop window a delegated `click`/`auxclick` handler on `document` sends every link whose origin is not the daemon's, or whose target is `_blank`, to the system browser (`https:` only) instead, because a webview has no tabs (§20.2).
- The daemon serves `index.html` for every path without an extension outside `/api`, `/hooks`, `/ws` and `/login`, so deep links and reloads work.
- Unknown repository ids, graphs or runs show a not-found state in the tab with a link to Home; they never redirect silently.

### 13.3 Home

Lists every registered repository with: name and path, availability, active runs, nodes waiting for approval, nodes waiting for input (incl. `idle`), last run time, and links to its graphs and active runs. Actions: **Open** (link to `/r/<repoId>`), **Add repository** (an absolute path field, `~/…` accepted → `POST /api/repos`; there is no file picker in a browser; the field says that graphs in a repository can run commands, §14), **Remove** (`DELETE /api/repos/:repoId`, with the 409 explained and a "Remove anyway" that sends `force`). It updates live from `repo:status` / `repo:removed` (§12.2). It also shows daemon-wide information: version and prerequisite warnings (`GET /api/daemon`). The first tab of a fresh profile is Home.

![Home with two registered repositories](screenshots/home.png)

`RepoSummary` = `{ id, path, name, available, active, error, addedAt, lastOpenedAt, lastRunAt, runs: { running, paused }, waiting: { approval, input } }` (`error`: the last activation failure, or null), computed from the DB (one grouped query), so inactive repositories have counters too.

### 13.4 Tabs

A Linear/Notion-like tab strip at the top of the page, implemented in React (it works in a browser tab as well as in the desktop window, where it is the window's title bar, §20).

- **Tab** = `{ id, path, title? }`, held by a global tab store (zustand). A tab may show any view of any repository.
- **Persistence is per window.** Several windows can be open on the same origin at once (each `promptgraph open` opens a browser tab, a link can be opened in a browser tab, a second desktop launch opens a second window) and they share `localStorage`, so the live tab set (tabs, active id, MRU order, at most 30 tabs) is kept in **`sessionStorage`** (`pg.tabs.v1`), which survives a reload but belongs to one window. Every change is also mirrored to `localStorage` (`pg.tabs.last.v1`), used only to seed a window that starts without a session tab set (a new browser window, the desktop app after a restart); last writer wins there, and no window reads it after its start. Both are validated with zod on load; corrupt data gives one Home tab. Browser storage is per origin, which is why the daemon's port is sticky (§4.1 item 2).
- **Titles** derive from the route and the repository cache: `<repo> · <graph>`, `<graph> #<shortId>`, `<node label> · #<shortId>`, `Report #<shortId>`, `Home`. The last derived title is persisted with the tab; the graph list of every repository that has a tab is loaded (not only for mounted views) and refreshes titles, and until data is known a title falls back to the last derived title, then to the route's shape (`Run`, `Step`, `Report`, `<repo> · Graph`), never a raw id. Run titles come from a mounted view (the repository cache has no runs), so an unmounted run tab keeps the title it was given while mounted. A status dot shows when the tab's repository has nodes waiting for the user (approval or input, from its `RepoSummary`). The window title follows the active tab.
- **Open**: "+" and the new-tab shortcut open Home in a new tab (always a new one, even if a Home tab exists); modified clicks on links open their target (§13.2). Before comparing, paths are normalised (no trailing slash, canonical percent-encoding). Opening a path another tab already shows activates that tab; opening `/r/<repoId>` activates the most recently used tab of that repository if there is one, so repeated `promptgraph open <repo>` calls do not pile up tabs. Navigating inside a tab may land on a path another tab shows: duplicates made that way are allowed. New tabs are added at the end of the strip. A window holds at most 30 tabs: opening one more moves the least recently used inactive tab to the closed stack. Only the active tab follows a finished run to its report automatically (§13.1).
- **Close**: the × button, middle-click on the tab and the close shortcut. Closing the active tab activates its right neighbour (else the left one); closing the last tab leaves a Home tab. Closed tabs go on a stack (at most 10) for "reopen closed tab".
- **Shortcuts** (one pure keymap resolver, `(event, {desktop, terminalFocused}) → action | null`, installed on `window` in the capture phase). Letters and digits match `event.code` (`KeyT`, `Digit1`), not `event.key`, so they work on every keyboard layout; an event with `AltGraph` set is never a shortcut (AltGr produces `[`, `]`, `@`… on many layouts).

  | Action | Desktop window | Browser (fallback; the browser reserves Ctrl+T/W/Tab) | While a terminal has focus |
  |---|---|---|---|
  | New tab | Ctrl+T | Alt+T | goes to the terminal |
  | Close tab | Ctrl+W | Alt+W | goes to the terminal |
  | Reopen closed tab | Ctrl+Shift+T | Alt+Shift+T | goes to the terminal |
  | Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PageDown / Ctrl+PageUp | Alt+PageDown / Alt+PageUp | handled |
  | Go to tab 1–8 / last | Ctrl+1–8 / Ctrl+9 | Alt+1–8 / Alt+9 | goes to the terminal |

  While a terminal has focus only tab switching is handled: Claude Code and readline use Ctrl+W, Ctrl+T, Alt+letters and Alt+digits themselves, and the terminal is the main view. The browser fallbacks also work in the desktop window. Some browsers or window managers take some of these keys before the page sees them (Firefox on Linux: Alt+1–9 switch browser tabs, Alt+letters open menus); the tab strip's controls always work, and D1/D4 (§17) record what is confirmed where. While a dialog or a menu is open (they trap focus and lock the pointer) no tab shortcut is handled.
- **Keep-alive**: inactive tabs stay mounted but hidden (`hidden` + `inert`), because rebuilding xterm instances and React Flow canvases is slow and loses scroll position. After a reload **only the active tab mounts**; other tabs mount the first time they are activated. At most **6** views are mounted; beyond that the least recently used one is unmounted (its descriptor stays and it remounts from its URL when activated), except that a view whose editor has unsaved or in-flight changes is never evicted. Each view gets `useTabActive()`: a hidden view never calls `term.open` or `fit`, does not focus terminals, sends no terminal input and no `pty:resize` (a hidden element measures 0×0, and the most recent resize drives a shared PTY's size), passes `null` key codes to React Flow (whose delete/selection keys listen on `document`), does not show its dialogs (they are portaled outside the hidden wrapper; they show again when the tab is activated) and refits canvas and terminals when shown again. Hidden views keep their run subscriptions and PTY attachments, so they are current when shown. Two views of the same node run share one PTY attachment; the second asks for the replay again, and both redraw from it.
- **State per view**: the editor, run and UI stores (drawer, dialogs) are instances created per mounted view and provided through React context; repository data (info, graph list, commands, pending approvals) is cached once per repository and shared by its tabs; daemon info, repositories, tabs, toasts and the WebSocket client are global. An editor store is shared by every view of the same `(repoId, graphId)` so two views never autosave over each other. Every `localStorage` key that refers to a graph or run includes the `repoId`.
- **No lost edits**: releasing the last reference to an editor store (closing the last tab that shows its graph) flushes its pending autosave before disposing it; `pagehide` flushes every dirty editor store (closing a browser tab or the desktop window).
- **Removed repository**: on `repo:removed` (§12.2) the repository's cache is dropped, its run and repository subscriptions and PTY attachments are released, and its editor stores are discarded with a toast ("<repo> was removed; unsaved changes to <graph> were not saved", since a save would hit 404). Its tabs stay open and show "Repository removed" with **Add again** (`POST /api/repos` with the path remembered from its last `RepoSummary`) and **Close tab**. After it is added again (same id, §4.2) the tabs reload.

### 13.5 Session, connection and version

- The browser holds a long-lived session cookie (§14), so the UI normally just works after a daemon restart: the WebSocket client keeps reconnecting while the daemon is down, with backoff of at most 5 s, a "Reconnecting…" banner, and refetches its views on `hello`.
- **Unreachable**: after 15 s without a connection the banner becomes "promptgraph is not reachable — run `promptgraph open` in a terminal" (it keeps retrying: the daemon may have been stopped, or restarted on another port, which a page cannot discover). In the desktop window the page instead calls `relogin` (§20.3) once after 10 s without an open socket (any state but open, including a socket that never opened after the page loaded); the shell's CLI call restarts the daemon if needed and navigates to its current origin. If that fails the page shows the message with a **Retry** button that calls `relogin` again.
- **Signed out**: a 401 (REST, or a socket closed with 4401; after a socket connect that never opened the client also probes `GET /api/daemon`, because browsers hide the status of a refused upgrade) means the token was rotated, the session was revoked or expired, or the cookie is missing: the page shows "Signed out — run `promptgraph open` in a terminal" and stops retrying; in the desktop window it calls `relogin` once automatically, then shows a **Sign in again** button.
- **No relogin loops**: a successful `relogin` loads a new page, so "once" must outlive the page. The window remembers each automatic attempt per reason in `sessionStorage` and skips the automatic call for the same reason within 60 s, showing the button at once (for example when the webview does not keep the session cookie and every new page is signed out again). The unreachable record is dropped when the socket opens; the signed-out one only expires, because a page whose socket opens while its requests keep failing with 401 would otherwise loop. `sessionStorage` is per origin, so the record does not follow a `relogin` that lands on another port: the first page on the new origin may make one more automatic attempt per reason. That is bounded, because the port is sticky (§4.1 item 2) and changes only when the sticky port is taken, so the cooldown is not also kept in the shell.
- **Version**: the web build embeds its version; when `hello.version` differs (the daemon was upgraded on disk but not restarted, or the other way round), a banner says "promptgraph was updated: run `promptgraph stop` and open it again". The daemon serves `index.html` with `Cache-Control: no-store`.

---

## 14. Security

The trust boundary is the user's account on one machine: anything running as the user can read `~/.promptgraph` and is trusted, like anything that can write `state.db` or the graph files. What must hold is that **other users, other local web origins and the Claude agents themselves** cannot drive the daemon.

- **Bind** to `127.0.0.1` only; reject requests whose `Host`/`Origin` is not a loopback name on the daemon's own port (DNS-rebinding and cross-port protection). The desktop window therefore loads the UI from `http://127.0.0.1:<port>` itself, never from a `tauri://` origin (§20).
- **Token**: one persistent random token per user in `~/.promptgraph/token` (mode 0600, directory 0700). Local clients (CLI, `promptgraph mcp`) read the file and send it as `Authorization: Bearer`. It is never printed, logged, put in a URL (there is no `?t=` on pages or on the WebSocket URL), put in a tool result or passed to a child process (§7.1, §7.6). A client sends it only after the daemon proved it knows it (`/api/daemon/hello`, §4.1 item 3), so a process of another user that binds the recorded port after a crash collects nothing.
- **Browser sessions**: a browser or desktop window holds the cookie `pg_session`: 32 random bytes, accepted only as a cookie (not as a Bearer credential), `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`. The daemon stores only its SHA-256 in the `sessions` table (§11.2) with a label, creation, last use and expiry: **30 days after the last use** (sliding; `last_seen_at` is written at most once an hour, and page loads renew the cookie). Sessions survive daemon restarts, are listed and revoked one by one with `promptgraph sessions`, and are all dropped by a token rotation. Revoking a session closes its WebSockets with 4401; so does its expiry, found at daemon start, when sessions are listed, on a request with its cookie or by an hourly sweep (a socket of a session that expires while connected closes within an hour).
- **Other loopback services see the cookie.** Cookies are not port-scoped and every localhost port is the same site, so the browser also sends `pg_session` to any other service on `127.0.0.1`/`localhost` the user visits (dev servers, Docker-published ports, another user's process), which could replay it outside a browser. Mitigations: sessions are random, expire when idle and are revocable one by one (`promptgraph sessions revoke --all` after visiting untrusted local services); browser-originated replays are refused by Fetch Metadata (next item); GETs have no side effects. Replaying with a non-browser client until the session expires remains possible (§17 R9).
- **Fetch Metadata and safe GETs**: a cookie-authenticated request to `/api/*` or `/ws` whose `Sec-Fetch-Site` is present and not `same-origin` or `none`, or (for `/api/*`) whose `Sec-Fetch-Mode` is `no-cors` or `navigate`, gets 403 `forbidden_cross_site`. This stops `<img>`/`<script>` requests and navigations from pages on other localhost ports, which carry the cookie (SameSite does not help between ports) and no `Origin`. Pages and assets are served to any navigation (they hold no data). No GET has side effects: repository activation happens only on POST, PUT, DELETE or `repo:subscribe` (§4.2). Cookie-authenticated API writes must also send `application/json` (forces a CORS preflight for cross-origin pages). Bearer requests come from local non-browser clients and are not subject to these checks.
- **Signing in** a browser or the desktop window uses a **one-time login code**: a local client with the token calls `POST /api/daemon/login-codes` (Bearer only; a cookie cannot mint codes) and opens `/login?code=<code>&next=<path>`. The code is 32 random bytes (base64url), single use, valid 30 s and held in memory. `GET /login` redeems it, creates a session, sets the cookie and redirects to `next` only if `isSafeNextPath(next)` holds **and** `new URL(next, origin)` keeps the daemon's origin with no user name or password; otherwise to `/`. An invalid or expired code gets the signed-out page. The token never appears in a URL or a process list; a login URL may appear for a moment in the arguments of `xdg-open` or the browser, which other users of the machine can read under `/proc`: whoever redeems it first gets the session, and if that is not the user, the user's browser shows the signed-out page (§17 R9).
- **Unauthenticated pages** get a small static HTML page (401, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `Cache-Control: no-store`): "promptgraph is running, but this browser is not signed in. Run `promptgraph open` in a terminal." API and WS requests get the JSON/HTTP 401.
- **Rotation** (`promptgraph token rotate`, `POST /api/daemon/token/rotate`): new token in memory and in the file, every session deleted, every WebSocket closed with 4401, outstanding login codes dropped. Sessions are tied to the token they were issued under: `meta.token_fingerprint` holds SHA-256 of the token (domain-separated, never the token), and a daemon that starts with a different token (rotated offline, replaced or deleted by hand) deletes every session before it serves a request, then records the new fingerprint. **Hook tokens** are `HMAC(hook secret, nodeRunId)` with a random hook secret per daemon start, held in memory only, so rotation never breaks the hook header files of live Claude sessions (§7.1); a hook token authorises only `POST /hooks/<nodeRunId>/*`.
- **Agents cannot approve their own gates.** Claude PTYs get no token, no session and no `PG_HOME`; the `--settings` file denies Claude's file tools access to the token, the DB and the hook header files (§7.6), and MCP exposes no approval tool (§19.3). A `Bash` command that reads the token needs the user's permission in the default permission mode. Same-user code outside Claude's permission system (shell nodes, other programs) is trusted: it could read the token as it could read `state.db`.
- **Registering a repository trusts it**: its graphs run commands (below). The daemon's read-only git calls (branch listing, status, diffs, `worktree prune`) pass `-c core.fsmonitor=false`, so listing an untrusted clone does not run its fsmonitor hook; operations that change a repository (worktrees, commits, merges) honour its configuration and hooks as git always does. `POST /api/repos` takes absolute paths only (§4.2).
- **Development**: the vite dev server proxies `/api`, `/ws` and `/login` to the daemon. It never reads the token and never adds credentials: the developer signs in with `promptgraph open --print-url --web-port <vite port>`, which builds the login URL on the vite origin; the cookie it sets (for host `127.0.0.1`, any port) then works on both. The proxy accepts only requests whose `Host` is the vite server (`server.allowedHosts`) and whose `Origin`, when present, is the vite origin (403 otherwise), forwards `Sec-Fetch-*` unchanged so the daemon's checks apply, and only then rewrites `Host`/`Origin` to the daemon.
- **Desktop shell** (§20): it gets the UI through `promptgraph open --print-url --json` and never sees the token. Its IPC capability is created at run time for the daemon's exact origin, its navigation guard keeps the webview on that origin, new-window requests are denied (https links go to the system browser), and the page may call only window controls and `relogin`.
- No `bypassPermissions` by default; nothing is pushed without an approval gate.
- Shell nodes run arbitrary commands by design: graph files are trusted like any script in the repo. The UI shows a warning when opening a graph modified outside the app since the last run (hash comparison).

---

## 15. Phase 2 — Control flow

### 15.1 Edge conditions

Each edge gets `when: "success" | "failure" | "always"` (default `success`). In the canvas, every node gets an extra **error port** (red); dragging from it creates a `failure` edge.

- A failed node with at least one matching `failure` edge **does not** pause the run: the failure is "handled" and the engine follows those edges. `onError` only applies when no failure edge exists.
- The failing node's output (error, exit code, stdout tail) flows into the next node's context block, so a "fix" node gets the failing test output automatically.
- Editor default: connecting a `shell` node to an `exitCode` condition creates the edge with `when: "always"` (not `success`), because a failing shell (exit code ≠ 0) would otherwise never reach the condition that is meant to evaluate it. As a consequence, such a shell's failure counts as handled (the always edge fires) and its `onError` does not apply.

### 15.2 Condition node

New node type `condition` with two output ports, `true` and `false`.

| Evaluator | Config | Evaluates |
|---|---|---|
| `exitCode` | `equals: 0` | The exit code of the predecessor (`shell`) |
| `regex` | `pattern`, `flags` | The predecessor's output text |
| `judge` | `question` | Headless `claude -p --json-schema '{"pass":boolean,"reason":string}'` with the predecessor's output and the lane diff stat. E.g. *"Did the review report any blocking issue?"* |

The `reason` from a judge becomes part of the condition's output and is passed to the next node's context.

### 15.3 Dead-path elimination and joins

- When a node completes, edges whose condition doesn't match deliver a **skip**. A node that receives only skips becomes `skipped` and propagates skips on all its outgoing edges.
- Join policy on nodes with multiple inputs: `join: "all"` (default; runs if ≥1 activation and all inputs resolved) — which naturally handles if/else re-joining. The Phase 1 rule "multi-input non-merge nodes are invalid" is relaxed: allowed when the validator can prove the inputs come from mutually exclusive ports of the same condition (otherwise a `merge` is still required because they'd be different lanes).
- Lanes: both branches of a condition stay in the **same lane** (only one of them runs), so no merge is needed.

### 15.4 Loops

- An edge can be marked as a **loop back-edge** with `loop: { maxIterations, onExhausted }`. Validation: removing all loop edges must leave a DAG; a loop edge must point to an ancestor of its source.
- The **loop body** = nodes on paths from the loop target to the loop edge's source.
- When the loop edge activates, the engine increments the iteration counter, resets body nodes to `pending` and creates new NodeRuns with `iteration + 1`. History of previous iterations is kept and browsable in the inspector (iteration selector).
- When `maxIterations` is reached and the loop edge would activate again: `onExhausted: "fail"` → the loop edge's source fails (routable via failure edges); `"continue"` → the edge delivers a skip and the flow continues along the other branch.
- Context inside loops: a body node with `context: "resume"` continues its own session from the previous iteration (it remembers what it tried); with `fresh` it gets the outputs of its predecessors in the current iteration (e.g. the judge's reason or the failing test output).

### 15.5 Canonical patterns

```
Test-fix loop
  [prompt: implement] → [shell: pnpm test] → [condition: exitCode = 0]
                              ▲                    │true → [commit] → [pr]
                              │ loop (max 3)       │false
                              └──── [prompt: fix failing tests] ◄┘

Review loop
  [prompt: implement] → [command: /code-review] → [condition: judge "blocking issues?"]
                              ▲                          │false → [command: /simplify] → [commit]
                              │ loop (max 2)             │true
                              └──── [prompt: address review findings] ◄┘

Failure routing
  [shell: pnpm build] ──error──► [prompt: fix the build error] → [shell: pnpm build]
```

In the test-fix loop the `shell → condition` edge is `always` (the editor's default for shell → exit-code condition, §15.1), and the loop edge targets the shell, not the condition: a loop back to an exit-code/regex condition would re-check the same output, so the validator rejects it.

### 15.6 UI additions

- Condition node with labelled `true`/`false` handles; error handles on all nodes.
- Loop edges drawn dashed, with an iteration badge (`2/3`) during runs.
- Inspector iteration selector for NodeRuns inside loops.
- Skipped nodes faded; dead edges greyed.

---

## 16. Milestones

| # | Milestone | Done when |
|---|---|---|
| **M0** | **Spike** (throwaway) | A script spawns `claude` in a PTY with injected hooks, receives `Stop`, reads the last message from the transcript, spawns a second session with it, and streams both to an xterm.js page where you can type. All assumptions in §17 checked |
| **M1** | Linear runner (= old "Phase 0") | Monorepo, CLI, server, SQLite, graph file, canvas with `prompt`/`command`/`shell`/`commit` nodes in a chain, single lane, live statuses, terminal drawer, completion policies |
| **M2** | Editor | Palette, inspector, validation, autosave, run history, replayed terminals, Reopen session |
| **M3** | Parallel | Lanes + worktrees, checkpoints, workspace setup, `merge` node (incl. Claude conflict resolution), concurrency limit, cleanup |
| **M4** | Ship-it nodes | `approval`, `pr` (push + `gh pr create`), diff viewer, generated commit/PR messages, crash resume |
| **M5** | Phase 2a | Edge conditions, error ports, `condition` node (exitCode, regex, judge), dead-path elimination |
| **M6** | Phase 2b | Loops, iterations in DB and UI |
| **M7** | Daemon | One daemon manages many repositories (§4): kernel-held lock, sticky port, verified discovery (`hello`), sanitised environment, repo registry with lazy loading and explicit activation, legacy-lock ownership, `repos`/`sessions`/`meta` tables, repo-scoped API and WS (§12), persistent token, server-side sessions, login codes, Fetch Metadata checks, friendly sign-in page (§14), CLI `daemon`/`ls`/`open`/`rm`/`stop`/`token rotate`/`sessions`, `promptgraph mcp` against the daemon (§19) |
| **M8** | Multi-repo UI | Router and URLs (§13.2), per-view stores, Home (§13.3), session/connection/version states (§13.5), then in-app tabs with per-window persistence, keep-alive and shortcuts (§13.4) |
| **M9** | Desktop | Tauri v2 shell for Linux (§20): attaches to or starts the daemon through the CLI, runtime capability for the daemon origin, tab strip as title bar (native decorations on WSLg), `relogin`; built only where Rust and WebKitGTK are installed |

---

## 17. Assumptions to validate (spike) and risks

| # | Assumption / risk | Validation / mitigation |
|---|---|---|
| A1 | `claude "<msg>"` in interactive mode accepts the initial message and processes slash commands passed that way (`claude "/simplify"`) | Spike. Fallback: write the command into the PTY after the TUI is ready (detected via `SessionStart` + small delay) |
| A2 | Hooks from `--settings` are merged with user hooks and inherit the process env (`PG_*`) | Spike. Fallback: encode node run id in the hook command line itself |
| A3 | `Stop` payload includes a usable `transcript_path`, and the last assistant message can be read reliably right after `Stop` | Spike. Fallback: poll the file briefly until the last line is an assistant message |
| A4 | `Notification` fires for permission prompts and idle-waiting, giving a reliable `waiting_input` signal | Spike. Fallback: detect idle PTY output + no hook activity for N seconds |
| A5 | **Workspace trust dialog** appears for each new worktree directory | Spike: check whether trusting `~/.promptgraph/worktrees/` (parent) covers children. Otherwise the first attach shows it and the node sits in `waiting_input` until answered |
| A6 | `--session-id` with a pre-generated UUID works in interactive mode and `--resume <id>` works afterwards | Spike |
| R1 | Usage limits with several parallel sessions | `maxParallelClaude` default 3; visible in terminal |
| R2 | `node_modules` & build caches per worktree are slow/large | `workspaceSetup` with pnpm (content-addressed store); keep lane count low |
| R3 | Auto-completion advances when Claude actually asked a question | Default `graceSec` + typing cancels; visible countdown with Hold (§7.4); `marker` mode for critical nodes; Hold toggle |
| R4 | Claude Code TUI changes between versions | We depend only on CLI flags and hook payloads, never on parsing the TUI |
| R5 | Alternative process backends | Keep `ClaudeRunner` behind an interface; candidates: tmux sessions (survive server restarts, `tmux attach` from a real terminal) or Claude Code's background sessions (`claude --bg` + `claude attach`, present in 2.1.x) |
| R6 | One daemon is a single point of failure for every repository | Same crash-resume as before (§8.6), now for all repositories at once; the daemon has no state outside the DB that a restart loses except live PTYs |
| R7 | The persistent token widens the blast radius of a leaked file to every repository | 0600/0700 re-asserted on start, never printed or put in a URL, sent only to a daemon that proved it knows it, denied to Claude's file tools, one-time login codes, `token rotate` (§14) |
| R8 | One environment for every repository's children (§4.1 item 5): a variable one project needs (nvm version, `AWS_PROFILE`, direnv) is no longer taken from the terminal that opened it | The daemon environment comes from the login shell, not the spawner, so it is the same whoever starts it; documented; per-repository environments are a possible extension |
| R9 | Session cookies are sent to every service on localhost; a login URL is briefly visible in `/proc` | Random server-side sessions with idle expiry and per-session revocation, Fetch Metadata checks, 30 s single-use codes; residual replay by a non-browser client accepted on a single-user machine (§14) |
| D1 | Tauri v2 with WebKitGTK renders the UI (xterm canvas, React Flow) acceptably and delivers Ctrl+T/W/Tab to the page | Check on a machine with WebKitGTK 4.1 (WSLg on WSL). Fallback: the Alt shortcuts (§13.4) |
| D4 | Browser fallback shortcuts reach the page (Firefox and Chrome on Linux, GNOME/KDE, WSLg) | Record per browser in the README checklist; the tab strip's controls always work |
| D5 | The shell sees every navigation: `on_navigation` for back/forward and redirects, `on_new_window` for `target=_blank` and `window.open` | Manual checklist (§20.5); the web also intercepts foreign and `_blank` links itself (§13.2) |
| D2 | A capability added at run time for `http://127.0.0.1:<port>` lets the daemon-served page call the window commands and `relogin`, including from deep paths (`/r/x/runs/y`) | Check with `withGlobalTauri`; the frontend contract is tested in TypeScript only (§20.5) |
| D3 | The Rust side cannot be compiled or run on the development machine (no Rust toolchain, no WebKitGTK) | Keep `src-tauri` small and free of logic: everything it needs is one CLI call with a zod-defined JSON answer; build in CI or on a machine with the toolchain |

---

## 18. Open questions

1. Should a `commit` node be auto-inserted before `pr` and `merge` when the lane is dirty, or should validation require it explicitly? (Proposal: checkpoint automatically, warn in validation.)
2. Desktop notifications (`Notification` → OS toast via `notify-send`/WSL) when a node needs input — in M2 or later?
3. Per-node cost/token display: the transcript contains usage; worth showing from M2?
4. Should `merge` support an octopus merge of N lanes in one step, or always sequential pairwise merges? (Proposal: sequential, in canvas order, so conflicts are resolved one branch at a time.)
5. Desktop: a tray icon that shows attention counts while every window is closed, and a single-instance launch that opens a tab in the existing window instead of a second window? (Proposal: after M9. Until then a second launch opens a second window with its own tab set (§13.4), and `promptgraph open` from a terminal opens the browser.)
6. Desktop: bundle Node and the server as a Tauri sidecar so the app installs without `promptgraph` on `PATH`? (Proposal: not before the daemon contract settles; M9 requires an installed `promptgraph`.)
7. Deactivate idle repository contexts (stop their graph watchers) after a while without open tabs or live runs? (Proposal: only if inotify limits show up.)

---

## 19. MCP server and Claude Code plugin

Claude Code can design, run and supervise graphs itself: `promptgraph mcp` is an MCP server (stdio) that drives the promptgraph daemon through its REST API (§12.1), and a Claude Code plugin installs it together with skills that teach the workflow. The MCP server is a client like the web UI. It never touches the engine, the state DB or graph files directly, so every rule enforced by the daemon (validation, the write guard during runs, approvals) applies unchanged.

```
Claude Code ──stdio──► promptgraph mcp ──REST /api/repos/<repoId>/… + Bearer──► promptgraph daemon (127.0.0.1) ◄── browser / desktop UI
                           │ reads ~/.promptgraph/daemon.json + ~/.promptgraph/token
```

### 19.1 Daemon discovery

The MCP server finds the daemon through `daemon.json` (§11.3) and the token file, using the same client as the CLI (`daemon/client.ts`): it verifies the daemon with `/api/daemon/hello` before it sends the token (§4.1 item 3) and refuses a daemon of another version with the message of §4.1 item 4. It re-reads both files on every tool call, so a restarted daemon (possibly on another port) or a rotated token is picked up without restarting Claude Code. Then it registers its repository (`POST /api/repos {path}`, idempotent; the `repoId` is cached per daemon pid and path) and sends every repository call under `/api/repos/<repoId>`. No credential appears in tool results, which go to the model provider: `open_ui` opens the browser with a one-time login URL and returns only the plain `http://127.0.0.1:<port>/r/<repoId>`, adding "run `promptgraph open` in a terminal" when no browser could be opened.

### 19.2 `promptgraph mcp`

- Started by Claude Code with the project directory as `cwd`; the repository is its git top level (`PROMPTGRAPH_REPO` or a tool's `repo` argument override it).
- stdout carries only the protocol. When the client disconnects (stdin ends), nothing keeps the process alive but calls in flight: they answer, then it exits.
- `start_server` runs `ensureDaemon` (§4.1: reuses a running daemon, otherwise spawns `promptgraph daemon` detached, with the sanitised environment of §4.1 item 5 rather than the Claude session's, and output in `~/.promptgraph/logs/daemon.log`) and registers the repository. The daemon outlives the Claude session on purpose, because runs take longer than one conversation; it stops with `promptgraph stop`.
- `server_status` reports whether the daemon runs (pid, version, port), whether this repository is registered, its `repoId` and its `RepoSummary` counters. Every other tool fails with "promptgraph is not running; call start_server" when there is no daemon, and registers the repository on first use otherwise.

### 19.3 Tools

| Group | Tools |
|---|---|
| Server | `server_status`, `start_server`, `open_ui` (names kept from the per-repository servers; they act on the daemon and this repository) |
| Graphs | `graph_reference` (markdown guide or JSON Schema), `list_graphs`, `get_graph`, `save_graph`, `validate_graph`, `delete_graph`, `list_commands` |
| Runs | `start_run`, `list_runs`, `get_run`, `wait_for_run`, `get_node_output`, `node_action` (done, fail, retry, skip, hold, release), `get_diff`, `get_run_report`, `cancel_run`, `resume_run`, `cleanup_run` |
| Approvals | `list_pending`, `get_approval` (read-only) |

- `save_graph` accepts a draft: edge `id`s and node `position`s may be omitted. Missing ids are derived from the endpoints. Missing positions come from a layered layout: the column is the longest path from a root over non-loop edges, and nodes are centred vertically. The draft is then parsed with `GraphSchema`, saved through `PUT /api/repos/:repoId/graphs/:id`, and validated. The validation result is returned so Claude can fix errors.
- Run tools return compact views: the latest attempt of each (node, iteration), outputs truncated, a `next` hint, and `attention` (the nodeRunIds of steps that need the user). `get_node_output` returns the full output.
- `wait_for_run` polls `GET /api/repos/:repoId/runs/:id` until the run is final or paused, or (by default) a step needs the user (`idle`, `waiting_input`, `waiting_approval`), or the timeout passes (at most 600 s; Claude calls it again).
- **Approvals are not exposed.** Approving or rejecting an `approval` or `pr` gate stays a human action in the UI (invariant: nothing leaves the machine without approval). An agent must not approve its own pull request. `get_approval` and `get_diff` let Claude summarise what the user is asked to approve.
- Destructive tools (`delete_graph`, `cancel_run`, `cleanup_run`) carry `destructiveHint`, and the skills ask the user before calling them.

### 19.4 Plugin

`plugins/promptgraph/` is a Claude Code plugin, listed by the repository's `.claude-plugin/marketplace.json`:

- `.mcp.json` registers the server as `${PROMPTGRAPH_BIN:-promptgraph} mcp`. `promptgraph` must be on `PATH`, or `PROMPTGRAPH_BIN` must point to `packages/server/dist/cli/index.js`.
- Skills: `design-graph` (turn a task into a graph: decomposition, lanes, merge, checks, loops, prompts that work on their own; `references/patterns.md` holds complete graphs, validated by a test), `run-graph` (confirm, start, supervise, handle each attention state, report), `review-run` (explain a run from its report and suggest changes to the graph).

### 19.5 Setup guide in the UI

The header has a **Claude Code** button that opens a wizard with five steps: connect (plugin or MCP only, with copy buttons for the commands, and `PROMPTGRAPH_BIN` for a plugin that cannot find `promptgraph`), check (`POST /api/repos/:repoId/claude-setup/check` runs `claude mcp get promptgraph` in the repository and reports whether it is configured), skills (what each skill does and example requests), tools (grouped by purpose), and prompts to try.

- `GET /api/repos/:repoId/claude-setup` derives the commands from the running daemon: the CLI entry (`process.argv[1]`), the Node binary, the tab's repository, and whether the checkout bundles the plugin (`.claude-plugin/marketplace.json` two levels above the server package). No state is stored. The check runs with `cwd` = the repository, because `claude mcp add` registers at local scope by default and local and project scopes depend on the directory.
- The skill and tool lists are the catalog in `packages/shared/src/mcp-guide.ts`. A test checks that the catalog names are exactly the registered MCP tools and that every skill has a `SKILL.md`, so the wizard cannot describe a tool that does not exist.
- The check only reads the output of `claude mcp get`; it does not install anything.

---

## 20. Desktop app (Tauri v2, Linux)

`packages/desktop` is a thin native shell around the same web UI, for a Linear/Notion-like window whose tab strip is the title bar. It is **not** a backend: the Node daemon stays the only server (`node-pty` and `better-sqlite3` cannot move into Rust or the webview), and the shell is one more client of it.

### 20.1 Process model

1. `promptgraph-desktop [repo-dir]` builds the main window in code (so the navigation and new-window handlers can be attached) on a bundled splash page (`packages/desktop/splash/index.html` and its `splash.js`, no network, no IPC) that says "Starting promptgraph…". The splash always has the native window frame, whatever the decorations setting (§20.2): it has no title bar of its own and no IPC to drag or close the window with. The repository argument is made absolute before it is passed on (resolved against the working directory when it does not exist), so the CLI never reads it as an option and reports the real error.
2. **Every time the splash finishes loading** (`on_page_load` for the splash URL: the `tauri:` scheme, or the origin of `tauri dev`'s built-in dev server in a dev build), the shell runs the CLI (one call at a time). Retry on the splash is therefore just `location.reload()`, and the first start is the same path. The CLI is run through the user's login shell, because an app started from a desktop menu or an AppImage has neither the user's `PATH` (nvm, pnpm, `~/.local/bin`) nor a clean environment: `$SHELL -ilc 'exec "$0" "$@"' <bin> open --print-url --json [--next <path>] [repo-dir]`, where `<bin>` is `PROMPTGRAPH_BIN` or `promptgraph`. That form is for POSIX shells (`sh`, `bash`, `zsh`, `dash`, `ash`, `ksh`, `mksh`, by the basename of `$SHELL`); for `fish` the script is `exec $argv` (fish passes the extra `-c` arguments in `$argv`), and any other shell (nushell, …) is replaced by `/bin/sh -lc 'exec "$0" "$@"'`. The shell runs in a new session (`setsid`), so an interactive shell finds no terminal to take over and its whole session can be killed, including anything a start-up file left running: on a timeout, and also once the CLI has exited and its output was read, so such jobs never keep the pipes (and the reader threads) alive. Its stdout and stderr are read as they arrive, and after it exits the shell uses what was read within a short grace period, so a background job of a start-up file that keeps the pipes open (no EOF) cannot hide the CLI's line. `LD_LIBRARY_PATH`, `LD_PRELOAD`, `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`, `GTK_*`, `GDK_*`, `GIO_*`, `GSETTINGS_*` and `WEBKIT_*` are removed from the shell's environment. The CLI starts the daemon detached if needed (§4.1, which sanitises the daemon environment again), registers the repository if one was given, and prints `OpenUrlResult {v, cliVersion, url, port, repoId}` (zod, `packages/shared/src/desktop.ts`). Shell start-up files may print to stdout, so the shell takes the **last** stdout line that parses as JSON.
3. The shell checks `v == 1`, sets the allowed origin to `http://127.0.0.1:<port>` (item 4 of §20.2), adds the IPC capability for that origin (§20.3) and navigates the window to `url`. The webview redeems the code, gets the session cookie in its own persistent cookie store, and lands on `/r/<repoId>` (or Home). From then on it is the web app served by the daemon, on the daemon's origin, so the Host/Origin checks of §14 apply unchanged.
4. **Errors** are shown on the splash by evaluating `window.__pgSplashError(message)` in it (a page load would start the CLI again): CLI not found, which is exit code 127 only, since stderr also carries the messages of the user's start-up files ("promptgraph CLI not found: install it with `npm i -g promptgraph` or set `PROMPTGRAPH_BIN`"), exit code 2 or a missing/other `v` ("promptgraph ≥ <version> is required"), a non-zero exit (its stderr), or no valid line within 30 s.
5. Closing the window does not stop the daemon: runs keep going, `promptgraph stop` stops it. A second launch opens a second window with its own tab set (§13.4; open question 5).

The shell never reads `~/.promptgraph/token` or `daemon.json` itself: the CLI is its only interface, so discovery, identity checks, start-up races and sign-in stay in TypeScript, tested once.

### 20.2 Window and title bar

- One window `main`, 1280×800 (minimum 900×600), `withGlobalTauri: true`. The web app detects the shell with `window.__TAURI__` behind a `DesktopBridge` (`packages/web/src/lib/desktop.ts`: `isDesktop`, `customTitleBar`, `minimize`, `toggleMaximize`, `isMaximized`, `close`, `startResizeDragging`, `setTitle`, `openExternal`, `relogin`); in a browser the bridge is inert and nothing desktop-specific renders. The web package does not depend on `@tauri-apps/api`.
- **Decorations**: `PG_DESKTOP_DECORATIONS=custom|native`; the default is `custom` (`decorations: false`) except under WSLg (`WSL_DISTRO_NAME` set), where undecorated windows often cannot be moved or resized, so the default is `native`. The window is built with native decorations for the splash (§20.1 item 1); with `custom` the shell turns them off right before it navigates to the daemon's page, and turns them back on when it shows a splash error. The shell tells the page through an initialization script that sets `window.__PG_DESKTOP__ = { customTitleBar }`; with native decorations the page renders neither window controls nor drag regions.
- With a custom title bar the tab strip (§13.4) is the title bar: `data-tauri-drag-region` sits on the strip's own element and on a dedicated `flex: 1` spacer after the tabs (the attribute applies only to the element that carries it, not to its children, so never on a container that tabs cover). Tauri's built-in drag-region script handles drag and double-click-to-maximise; the page adds no double-click handler of its own. Window controls (minimise, maximise/restore, close) sit at its right end; the maximise icon re-queries `isMaximized` on the DOM `resize` event, and a failing window call is ignored. Thin edge handles call `startResizeDragging(direction)` (not shown while maximised). Pages without the tab strip (the signed-out screen) keep a bare title bar: a drag region, the window controls and the edge handles. The Ctrl shortcuts of §13.4 apply.
- The active tab's title becomes the window title (`setTitle`) with either kind of decorations, because the shell does not copy `document.title` to the native window.
- Links to other origins (pull requests, docs) open in the system browser (`openExternal`, `https:` only), through the delegated link handler of §13.2. Links in a terminal (PR or sign-in URLs Claude prints) go to `openExternal` through the xterm web-links handler: its default `window.open()` without a URL would be denied by the new-window guard.
- **Navigation guard** (`on_navigation`): the allowed origin lives in shared state (a `Mutex`) and is updated by every successful CLI call, including `relogin`, so a daemon restarted on another port is followed. Allowed: that origin, and the splash only while the shell itself is showing it (start, retry, error). Anything else is cancelled; `https:` URLs are handed to the system browser. After the first successful load, a back navigation to the splash is refused. New-window requests (`target=_blank`, `window.open`, middle-click) are denied by `on_new_window`, `https:` ones opened in the system browser.
- **Development**: only in debug builds (`#[cfg(debug_assertions)]`), `PG_DESKTOP_ORIGIN=http://127.0.0.1:5173` rewrites the login URL to the vite dev server (which proxies `/login`, §14), and the allowed origin and the capability are computed from the rewritten URL.

### 20.3 IPC surface

The page is remote content (served by the daemon), so it reaches Tauri IPC only through a capability with remote URLs. There is **no static capability file with a remote URL**: once the port is known the shell adds one at run time for the window `main` and exactly `http://127.0.0.1:<port>` and `http://127.0.0.1:<port>/*` (a wildcard port would grant IPC to any loopback service, including other users'). If a later CLI call returns another port, a capability for the new origin is added; the old one cannot be removed, but the navigation guard keeps the webview off it. The capability grants exactly: `core:window:allow-minimize`, `allow-toggle-maximize`, `allow-internal-toggle-maximize` (used by the drag region's double-click), `allow-is-maximized`, `allow-close`, `allow-start-dragging`, `allow-start-resize-dragging`, `allow-set-title`, `opener:allow-open-url` limited to `https://*`, and one app command, **`relogin { next }`** (permission `allow-relogin`, generated by `build.rs` through `tauri_build::Attributes::new().app_manifest(AppManifest::new().commands(&["relogin"]))`): the shell re-runs the CLI with `--next <next>` (`next` must be a path starting with a single `/`, with no `//` and no backslash), updates the allowed origin and the capability, and navigates the window to the new login URL. The page uses it when it is signed out or the daemon is unreachable (§13.5). No command returns a URL, a code or the token to JavaScript. The command names live in `DESKTOP_COMMANDS` (`packages/shared/src/desktop.ts`).

### 20.4 Build

- `packages/desktop`: `src-tauri/` (`Cargo.toml`, `build.rs`, `tauri.conf.json`, `src/main.rs`, icons; no `capabilities/` directory, since the only capability is the one added at run time and the splash needs no IPC), `splash/` (`index.html` and `splash.js`: a script file rather than an inline script, so the splash CSP needs no hashes), `test/` and a README with the manual checklist. Rust holds no logic beyond: build the window, run the CLI through the login shell and parse its last JSON line (`serde_json`), the allowed-origin state, the runtime capability, navigation and new-window guards, splash errors and `relogin` (target: about 300 lines).
- Scripts: `typecheck` and `test` (TypeScript only); `tauri:dev` (`cargo tauri dev`) and `tauri:build` (`cargo tauri build --bundles deb,appimage`). There is no `build` script, so `pnpm -r build` and `pnpm install` never need Rust. The Tauri CLI comes from `cargo install tauri-cli --version "^2"`, not from npm.
- Requirements to build: Rust stable and Tauri's Linux prerequisites (`libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libxdo-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`). On WSL the window needs WSLg. Developing the web UI inside the shell: a debug build with `PG_DESKTOP_ORIGIN` (§20.2).

### 20.5 What is verified where

| Where | What |
|---|---|
| Every machine (vitest) | `OpenUrlResult` and `promptgraph open --print-url --json [--next]` (server tests); `DesktopBridge` with a fake `window.__TAURI__`, title-bar rendering with custom and native decorations, the delegated link handler, auto-`relogin` and shortcuts in desktop mode (web tests); `packages/desktop/test/contract.test.ts` reads the Rust, JSON and TOML files as text and checks the invariants above: global API, splash as `frontendDist`, no static capability with a remote URL and no `127.0.0.1:*` anywhere, the exact permission list, `build.rs` declaring exactly the commands of `DESKTOP_COMMANDS`, the CLI arguments, the login-shell invocation (POSIX, fish and the `/bin/sh` fallback, `setsid`, the session kill on timeout, output read without waiting for EOF), the splash keeping native decorations, and stripped variables, `on_navigation`, `on_new_window` and `on_page_load` handlers, the `Mutex` origin updated by `relogin`, `PG_DESKTOP_ORIGIN` only under `cfg(debug_assertions)`, no access to `token` or `daemon.json`, and a splash without external URLs |
| Only with Rust + WebKitGTK | Compiling and bundling, the splash with its native frame and the switch to the custom title bar on navigation, window dragging, double-click maximise, edge resizing (X11, Wayland, WSLg), window controls, shortcut delivery (D1, D4), IPC from the remote page including deep paths (D2), navigation and new-window coverage incl. back to the splash (D5), external links, start from a desktop menu without `PATH`, `relogin` after `promptgraph token rotate` and after `promptgraph stop`. The README checklist lists these steps; they are not run in the default test suite |
