# promptgraph — Design Document

> Status: draft · Scope: Phase 0–1 (Core) and Phase 2 (Control flow) · Audience: personal use (single user, Linux/WSL)

`promptgraph` is a local tool, started from the terminal, that serves a React UI on `localhost`. In it you draw a flow diagram where each box is a step (a Claude Code prompt, a slash command, a shell command, a commit, a PR…), run it, and watch each box progress in real time. Clicking a box opens the **real, interactive Claude Code terminal** of that step.

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

- Multi-user, auth, remote hosting. It binds to `127.0.0.1` only.
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
┌──────────────────────────── Browser (localhost) ────────────────────────────┐
│ React + Vite                                                                 │
│  ├─ Canvas (@xyflow/react)      ├─ Inspector (node config)                   │
│  ├─ Run view (live statuses)    ├─ Terminal drawer (xterm.js, one per node)  │
│  └─ Approval dialog (diff)      └─ Run history                               │
└───────────────▲───────────────────────────────▲──────────────────────────────┘
                │ REST (graphs, runs)            │ WebSocket (events, PTY I/O)
┌───────────────┴───────────────────────────────┴──────────────────────────────┐
│ Node server (Hono + ws)                                                      │
│  ├─ Graph store ── .promptgraph/graphs/*.json (in the target repo)           │
│  ├─ Engine ─────── scheduler, state machine, activation tokens               │
│  ├─ Workspaces ─── git worktree lanes, checkpoints, merges                   │
│  ├─ Runners ────── ClaudeRunner (node-pty) · ShellRunner · GitRunner         │
│  ├─ Hook receiver  POST /hooks/:nodeRunId/:event  (from Claude Code hooks)   │
│  └─ Store ──────── SQLite (~/.promptgraph/state.db): runs, node runs, events │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ spawn (PTY)                          ▲ curl (hook scripts)
        ┌───────┴──────────┐                           │
        │ claude (interactive) in worktree  ───────────┘
        │ --session-id --settings(hooks) --permission-mode …
        └──────────────────┘
```

### 3.1 Tech stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node 22, TypeScript, pnpm workspace | `node-pty` and the Agent ecosystem are Node-native |
| Server | Hono + `ws` | Small, typed, easy WebSocket upgrade |
| PTY | `node-pty` | Real TTY so Claude Code runs its interactive TUI |
| DB | `better-sqlite3` | Synchronous, zero-config, crash-safe enough for one user |
| Validation | `zod` | Single schema for graph files, API and WS messages |
| UI | React 19, Vite, `@xyflow/react`, `@xterm/xterm` (+ fit, web-links addons), `zustand`, Tailwind | Standard; React Flow covers nodes/ports/edges/minimap |
| Diff view | `react-diff-view` or `diff2html` | Approval dialog |

### 3.2 Repository layout

```
promptgraph/
  packages/
    shared/   # zod schemas, TS types, WS protocol
    server/   # engine, runners, store, HTTP/WS, CLI entry (bin: promptgraph)
    web/      # React app (built assets are served by the server)
  docs/
```

---

## 4. CLI

```bash
promptgraph [repo-dir] [--port 4777] [--no-open]
```

1. Resolves `repo-dir` (default `cwd`) to the git top-level. Fails if not a git repo.
2. Checks prerequisites: `git`, `claude`, `gh` (only warns; `gh` is needed for PR nodes).
3. Creates `.promptgraph/graphs/` if missing.
4. Generates a random session **token**, starts the server on `127.0.0.1:<port>`, and opens `http://127.0.0.1:<port>/?t=<token>`.
5. On SIGINT: asks running Claude PTYs to exit (`/exit`), waits up to 5s, then kills; marks running node runs as `interrupted` (resumable, §8.6).

One server instance manages **one repository**.

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
- Env: inherits the user's env plus `TERM=xterm-256color`, `PG_PORT`, `PG_HOOK_HEADER_FILE`, `PG_NODE_RUN_ID`. The session token is never passed to Claude: the header file (mode 0600, in the run dir) holds a per-node-run hook token, `HMAC(session token, nodeRunId)`, that only authorises `POST /hooks/<nodeRunId>/*`.
- `<initial message>` for `command` nodes is the slash command itself (`/simplify`); for `prompt` nodes it is the prompt plus the context block (§7.5).

### 7.2 Hook injection

`hooks.json` (generated once per run) adds hooks on top of the user's own (Claude Code merges settings sources):

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

On startup the server finds runs with NodeRuns in `running`/`waiting_*` state and marks them `interrupted`, the run `paused`. **Retry** on an interrupted Claude node spawns `claude --resume <session-id>` with the message *"You were interrupted. Continue the task."* (completion policy applies normally).

---

## 9. Workspaces and lanes

### 9.1 Layout

```
~/.promptgraph/worktrees/<repo-name>/<run-id>/<lane-id>/   # git worktree
branches: <branchPrefix>/<run-short-id>/<lane-id>           # e.g. pg/feature-x/3f9a/main
```

Worktrees live outside the repo to avoid polluting it and to avoid nested-repo confusion for tools.

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

At run end, per `keepWorktrees`: `git worktree remove --force` + delete local branches that were not pushed and hold no commits of their own (or were merged). Pushed branches, and unpushed branches carrying commits (e.g. from a commit node), are kept so no committed work is lost. A **"Clean up"** action in run history does the same on demand. `git worktree prune` runs at server start.

---

## 10. Approval gates

- `approval` node: pauses with status `waiting_approval`. The UI shows a dialog with: the message, the lane's diff against `baseBranch` (file list + unified diff), outputs of predecessors, and **Approve / Reject (+ comment)**.
- `pr` node with `requireApproval: true` shows the same dialog, plus the generated title/body editable before pushing.
- Approvals can be given from the canvas (violet node → click) or from a global "Pending" counter in the header.

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

Terminal logs: `~/.promptgraph/runs/<run-id>/<node-run-id>.log`.

---

## 12. Server API

### 12.1 REST

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/graphs` | List graphs in the repo |
| GET/PUT/DELETE | `/api/graphs/:id` | Read / save / delete a graph |
| POST | `/api/graphs/:id/validate` | Validation errors (cycles, invalid joins, missing config) |
| POST | `/api/graphs/:id/runs` | Start a run |
| GET | `/api/runs?graph=` | Run history |
| GET | `/api/runs/:id` | Run + lanes + node runs |
| POST | `/api/runs/:id/cancel` | Cancel |
| POST | `/api/node-runs/:id/{done,fail,retry,skip,hold}` | Manual controls |
| POST | `/api/node-runs/:id/approval` | `{ approved, comment, title?, body? }` |
| GET | `/api/node-runs/:id/diff` | Lane diff vs base |
| POST | `/api/node-runs/:id/reopen` | Spawn `claude --resume` PTY for a finished node |
| GET | `/api/commands` | Available slash commands/skills (for the `command` picker) |
| POST | `/hooks/:nodeRunId/:event` | Hook receiver (token-protected) |

All routes require the token (`Authorization: Bearer` or the `t` cookie set from the opening URL).

### 12.2 WebSocket (`/ws`)

```ts
// server → client
{ type: "run:update", run }
{ type: "node:update", nodeRun }              // status, activity, output
{ type: "pty:data", ptyId, data }             // base64
{ type: "pty:exit", ptyId, code }
// client → server
{ type: "subscribe", runId }
{ type: "pty:attach", ptyId }                 // server replies with buffered output first
{ type: "pty:input", ptyId, data }
{ type: "pty:resize", ptyId, cols, rows }
```

---

## 13. UI

- **Header**: graph selector, Run / Cancel, pending approvals counter, run selector (live or historical).
- **Canvas** (React Flow): palette on the left (drag node types in), minimap, snap to grid. In run mode the graph is read-only and nodes show status colour, elapsed time, last activity, and lane badge (colour per lane so you can see worktrees at a glance).
- **Inspector** (right): config of the selected node; in run mode, its NodeRun details (output, session id, branch, timings, error) and controls (Done, Fail, Hold, Retry, Skip).
- **Terminal drawer** (bottom, resizable): opens on node click. Tabs, one per open terminal. Live PTY for running nodes, replayed log for finished ones with "Reopen session".
- **Approval dialog**: diff viewer + approve/reject.
- **Validation**: invalid nodes/edges are outlined red with a tooltip; Run is disabled while there are errors.

---

## 14. Security

- Bind to `127.0.0.1` only; reject requests whose `Host`/`Origin` is not localhost (DNS-rebinding protection).
- Random per-start token required by REST, WS and hook endpoints.
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
| R3 | Auto-completion advances when Claude actually asked a question | Default `graceSec` + typing cancels; `marker` mode for critical nodes; Hold toggle |
| R4 | Claude Code TUI changes between versions | We depend only on CLI flags and hook payloads, never on parsing the TUI |
| R5 | Alternative process backends | Keep `ClaudeRunner` behind an interface; candidates: tmux sessions (survive server restarts, `tmux attach` from a real terminal) or Claude Code's background sessions (`claude --bg` + `claude attach`, present in 2.1.x) |

---

## 18. Open questions

1. Should a `commit` node be auto-inserted before `pr` and `merge` when the lane is dirty, or should validation require it explicitly? (Proposal: checkpoint automatically, warn in validation.)
2. Desktop notifications (`Notification` → OS toast via `notify-send`/WSL) when a node needs input — in M2 or later?
3. Per-node cost/token display: the transcript contains usage; worth showing from M2?
4. Should `merge` support an octopus merge of N lanes in one step, or always sequential pairwise merges? (Proposal: sequential, in canvas order, so conflicts are resolved one branch at a time.)
