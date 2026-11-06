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
| UI | React 19, Vite, `@xyflow/react`, `@xterm/xterm` (+ fit, web-links addons), `zustand`, Tailwind v4, shadcn/ui (Radix primitives) | Standard; React Flow covers nodes/ports/edges/minimap; shadcn/Radix give accessible dialogs, menus, tabs and form controls (focus trap/restore, keyboard navigation) |
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

`promptgraph mcp` runs the MCP server for Claude Code instead (§19.2).

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
- At server start, the refs of runs that finished more than 30 days ago (or are unknown) are deleted. They live under `refs/promptgraph/`, so `git branch` does not list them and a normal `git push` does not send them.

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
CREATE TABLE chat_sessions (             -- chat panel, §20.8; history comes from the Claude transcript
  id TEXT PRIMARY KEY,                   -- = Claude session id
  repo_path TEXT, title TEXT, model TEXT,
  total_cost_usd REAL,
  started INTEGER,                       -- 1 once Claude created the session: the next process uses --resume
  created_at INTEGER, updated_at INTEGER
);
```

Terminal logs: `~/.promptgraph/runs/<run-id>/<node-run-id>.log`.

---

## 12. Server API

### 12.1 REST

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/graphs` | List graphs in the repo |
| GET/PUT/DELETE | `/api/graphs/:id` | Read / save / delete a graph. `PUT ?baseHash=<hash>` saves only if the file still has that hash, else 409 `graph_conflict` (§20.7) |
| POST | `/api/graphs/:id/validate` | Validation errors (cycles, invalid joins, missing config) |
| POST | `/api/graphs/:id/runs` | Start a run |
| GET | `/api/runs?graph=` | Run history |
| GET | `/api/runs/:id` | Run + lanes + node runs |
| POST | `/api/runs/:id/cancel` | Cancel |
| POST | `/api/node-runs/:id/{done,fail,retry,skip,hold}` | Manual controls |
| POST | `/api/node-runs/:id/approval` | `{ approved, comment, title?, body? }` |
| GET | `/api/node-runs/:id/diff?scope=lane\|node` | Lane diff vs base (default), or what the node changed (§9.7) |
| GET | `/api/runs/:id/report` | Run report (§13.1) |
| GET | `/api/runs/:id/lanes/:laneId/diff` | Lane diff vs base, also after cleanup (from snapshots) |
| POST | `/api/node-runs/:id/reopen` | Spawn `claude --resume` PTY for a finished node |
| GET | `/api/commands` | Available slash commands/skills (for the `command` picker) |
| GET/POST | `/api/chat/sessions` | List chat sessions / create one (`{ model? }`), §20 |
| GET/DELETE | `/api/chat/sessions/:id` | Session + item history + open permission prompts + partial streamed text / delete (kills the process; the Claude transcript stays) |
| GET | `/api/voice` | Voice dictation status (`VoiceStatus`, §21): whisper binary and model found, why not, setup lines, resolved mode / language / autoSubmit and where each came from. Cached for 5 s; `?refresh=1` ("Check again") re-probes, at most once per second and coalesced with a probe in flight; honoured only without `Sec-Fetch-Site` or with `same-origin`/`none` (a probe spawns `whisper-cli --help`, and the cookie also rides subresource GETs from other localhost ports) |
| POST | `/hooks/:nodeRunId/:event` | Hook receiver (token-protected) |

All routes require the token (`Authorization: Bearer` or the `t` cookie set from the opening URL).

### 12.2 WebSocket (`/ws`)

```ts
// server → client
{ type: "run:update", run }
{ type: "node:update", nodeRun }              // status, activity, output
{ type: "pty:data", ptyId, data }             // base64
{ type: "pty:exit", ptyId, code }
{ type: "graphs:changed", graphId }
{ type: "chat:item", sessionId, item }        // §20: normalised ChatItem
{ type: "chat:delta", sessionId, messageId, text, offset } // streamed assistant text; offset = chars streamed before it
{ type: "chat:status", sessionId, status, warning? }
{ type: "chat:session", session }             // created / metadata changed
{ type: "chat:deleted", sessionId }
{ type: "voice:partial", voiceId, text }      // §21: transcript of all audio so far (replaces, not a delta)
{ type: "voice:final", voiceId, text, truncated?, notice? } // terminal; truncated = stopped at the 2 min cap; notice = final pass failed, text is the last partial
{ type: "voice:error", voiceId, code, message } // terminal; code: unavailable | too_long | failed | busy | cancelled
// client → server
{ type: "subscribe", runId }
{ type: "pty:attach", ptyId }                 // server replies with buffered output first
{ type: "pty:input", ptyId, data }
{ type: "pty:resize", ptyId, cols, rows }
{ type: "chat:send", sessionId, text, context }
{ type: "chat:interrupt", sessionId }
{ type: "chat:permission", sessionId, requestId, allow, message? }
{ type: "voice:start", voiceId, sampleRate: 16000, keyterms?, language? } // §21
<binary frame>                                // voice audio: LE Int16 mono PCM, 16 kHz, ~100 ms per frame
{ type: "voice:stop", voiceId }
{ type: "voice:cancel", voiceId }
```

`run:update`, `graphs:changed` and every `chat:*` message are broadcast to all clients (one user); `voice:*` replies go only to the client that started the recording. Text frames are JSON; the only binary frames are voice audio (§21.4). The full protocol is `packages/shared/src/ws.ts`.

---

## 13. UI

- **Header**: graph selector, run selector (live or historical), pending approvals counter, settings.
- **Canvas** (React Flow): palette on the left (drag node types in), minimap, snap to grid. Floating over its top right corner: a "Saving…" spinner while an edit is being autosaved (nothing once saved; the error if a save fails), the problems button, the run's cost and **Report**, **Undo / Redo**, and Resume / Run / Cancel. In run mode the graph is read-only and nodes show status colour, elapsed time, last activity, and lane badge (colour per lane so you can see worktrees at a glance).
- **Inspector** (right): config of the selected node; in run mode, its NodeRun details (output, session id, branch, timings, error) and controls (Done, Fail, Hold, Retry, Skip).
- **Terminal drawer** (bottom, resizable): opens on node click. Tabs, one per open terminal. Live PTY for running nodes, replayed log for finished ones with "Reopen session".
- **Approval dialog**: diff viewer + approve/reject.
- **Diff dialog**: what a node changed (§9.7), with a switch to its whole lane; opened from the inspector and the report.
- **Validation**: invalid nodes/edges are outlined red with a tooltip; Run is disabled while there are errors.
- **Undo / Redo**: always shown left of Run, disabled when there is nothing to undo or redo, while the graph is read-only and in run mode; also Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) outside text fields and terminals. The editor keeps an in-memory history of the open graph's local edits (at most 100 steps; consecutive edits of the same node, edge, drag, name or settings less than a second apart share one step). Undo and redo are ordinary edits, so they autosave. The history is cleared when another graph opens or the graph is (re)loaded from disk, so a version older than the file is never written back silently; when the graph was reloaded because it changed outside the editor, Undo reverts that change (§20.9).

### 13.1 Run report

A page that answers "what happened while I was away". It replaces the editor view until closed; it opens from **Report** on the canvas, from each run in the history, and by itself when the run shown on the canvas finishes. It follows the run live.

- **Summary**: result, duration, total time spent waiting for the user, estimated cost, step counts, the run error.
- **Where it stopped or waited**: unhandled failures, interruptions, cancellations and steps waiting for the user now; then waits of at least a minute, longest first. Waiting time is the time a node run spent in `idle`, `waiting_input` or `waiting_approval`, from the `node.status` events.
- **Steps**: one row per (node, iteration), latest attempt: result, attempts, duration, waited, what it changed (opens its diff), cost, and its output (commit, PR, approval, branch taken, error).
- **Pull requests** and **lanes**: per lane its branch, state, changes and commits since the base branch (checkpoints marked), and its diff.

![The run report of a fan-out run that opened a pull request](screenshots/run-report.png)

---

## 14. Security

- Bind to `127.0.0.1` only; reject requests whose `Host`/`Origin` is not localhost (DNS-rebinding protection).
- Random per-start token required by REST, WS and hook endpoints. Local clients (the MCP server, §19) read it from the server-info record, a mode-0600 file under `~/.promptgraph`, the same trust boundary as the state DB.
- No `bypassPermissions` by default; nothing is pushed without an approval gate.
- Shell nodes run arbitrary commands by design: graph files are trusted like any script in the repo. The UI shows a warning when opening a graph modified outside the app since the last run (hash comparison).
- Binary WebSocket frames are accepted only as voice audio (§21): routed to the sending client's active voice session, ignored when it has none, at most 64 KiB per frame and 2 minutes of audio (3 840 000 bytes) per session. Audio is never logged, never persisted beyond a mode-0600 temp WAV (in a per-server 0700 directory) deleted after each transcription pass, and never leaves the machine. whisper-cli is spawned with an argument array (no shell), and nothing derived from the audio is ever put in its arguments.

---

## 15. Phase 2 — Control flow

### 15.1 Edge conditions

Each edge gets `when: "success" | "failure" | "always"` (default `success`). In the canvas, every node gets an extra **error port** (red, on its right edge, so error handlers sit beside the main flow); dragging from it creates a `failure` edge.

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

- Condition node with labelled `true`/`false` handles on its bottom edge; error handles (right edge) on all nodes.
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
| R3 | Auto-completion advances when Claude actually asked a question | Default `graceSec` + typing cancels; visible countdown with Hold (§7.4); `marker` mode for critical nodes; Hold toggle |
| R4 | Claude Code TUI changes between versions | We depend only on CLI flags and hook payloads, never on parsing the TUI |
| R5 | Alternative process backends | Keep `ClaudeRunner` behind an interface; candidates: tmux sessions (survive server restarts, `tmux attach` from a real terminal) or Claude Code's background sessions (`claude --bg` + `claude attach`, present in 2.1.x) |

---

## 18. Open questions

1. Should a `commit` node be auto-inserted before `pr` and `merge` when the lane is dirty, or should validation require it explicitly? (Proposal: checkpoint automatically, warn in validation.)
2. Desktop notifications (`Notification` → OS toast via `notify-send`/WSL) when a node needs input — in M2 or later?
3. Per-node cost/token display: the transcript contains usage; worth showing from M2?
4. Should `merge` support an octopus merge of N lanes in one step, or always sequential pairwise merges? (Proposal: sequential, in canvas order, so conflicts are resolved one branch at a time.)

---

## 19. MCP server and Claude Code plugin

Claude Code can design, run and supervise graphs itself: `promptgraph mcp` is an MCP server (stdio) that drives a running promptgraph server through its REST API (§12.1), and a Claude Code plugin installs it together with skills that teach the workflow. The MCP server is a client like the web UI. It never touches the engine, the state DB or graph files directly, so every rule enforced by the server (validation, the write guard during runs, approvals) applies unchanged.

```
Claude Code ──stdio──► promptgraph mcp ──REST + Bearer token──► promptgraph server (127.0.0.1) ◄── browser UI
                           │ reads ~/.promptgraph/servers/<repo-key>.json
```

### 19.1 Server discovery

Once listening, the server writes `~/.promptgraph/servers/<repo-key>.json` (`ServerInfo`: pid, repo path, port, token, version; mode 0600; atomic) and removes it on shutdown. `<repo-key>` is the hash also used by the instance lock. A record whose pid is dead is stale and ignored. The MCP server re-reads the record on every tool call, so a restarted server (new port and token) is picked up without restarting Claude Code. The token never appears in tool results: `open_ui` opens the browser with it, and returns the URL only if no browser could be opened.

### 19.2 `promptgraph mcp`

- Started by Claude Code with the project directory as `cwd`; the repository is its git top level (`PROMPTGRAPH_REPO` or a tool's `repo` argument override it).
- stdout carries only the protocol. When the client disconnects (stdin ends), nothing keeps the process alive but calls in flight: they answer, then it exits.
- `start_server` spawns `promptgraph <repo> --no-open --port 0` **detached**, with output appended to `~/.promptgraph/logs/server-<repo-key>.log`, and waits up to 20 s for its record. The server outlives the Claude session on purpose, because runs take longer than one conversation. It stops like any server (Ctrl-C in a terminal, or `kill <pid>`).

### 19.3 Tools

| Group | Tools |
|---|---|
| Server | `server_status`, `start_server`, `open_ui` |
| Graphs | `graph_reference` (markdown guide or JSON Schema), `list_graphs`, `get_graph`, `save_graph`, `patch_graph`, `validate_graph`, `delete_graph`, `list_commands` |
| Runs | `start_run`, `list_runs`, `get_run`, `wait_for_run`, `get_node_output`, `node_action` (done, fail, retry, skip, hold, release), `get_diff`, `get_run_report`, `cancel_run`, `resume_run`, `cleanup_run` |
| Approvals | `list_pending`, `get_approval` (read-only) |

- `save_graph` accepts a draft: edge `id`s and node `position`s may be omitted. Missing ids are derived from the endpoints. Missing positions come from a layered top-to-bottom layout: the row is the longest path from a root over non-loop edges (a failure edge does not add a row, so an error handler sits to the right of its source), and the nodes of a row are centred horizontally, nodes reached only through failure edges last. The draft is then parsed with `GraphSchema`, saved through `PUT /api/graphs/:id`, and validated. The validation result is returned so Claude can fix errors. `save_graph` refuses to turn on `settings.allowPrWithoutApproval` unless the file on disk already has it: only the user unlocks PRs without approval, in the UI (invariant 4).
- `patch_graph` (`{ graphId, ops, repo? }`) edits an existing graph with the ops of §20.7 instead of rewriting it: it reads the graph and its hash, applies `applyGraphPatch` (`packages/shared/src/graph-patch.ts`), saves with `PUT /api/graphs/:id?baseHash=<hash>`, validates, and returns the added / removed / updated node ids and the validation result. Existing nodes keep their ids and positions. On 409 `graph_conflict` (the graph changed in between) it tells Claude to re-read the graph and retry. It is not destructive: every change can be undone from the UI (§20.9).
- Run tools return compact views: the latest attempt of each (node, iteration), outputs truncated, a `next` hint, and `attention` (the nodeRunIds of steps that need the user). `get_node_output` returns the full output.
- `wait_for_run` polls `GET /api/runs/:id` until the run is final or paused, or (by default) a step needs the user (`idle`, `waiting_input`, `waiting_approval`), or the timeout passes (at most 600 s; Claude calls it again).
- **Approvals are not exposed.** Approving or rejecting an `approval` or `pr` gate stays a human action in the UI (invariant: nothing leaves the machine without approval). An agent must not approve its own pull request. `get_approval` and `get_diff` let Claude summarise what the user is asked to approve.
- Destructive tools (`delete_graph`, `cancel_run`, `cleanup_run`) carry `destructiveHint`, and the skills ask the user before calling them.

### 19.4 Plugin

`plugins/promptgraph/` is a Claude Code plugin, listed by the repository's `.claude-plugin/marketplace.json`:

- `.mcp.json` registers the server as `${PROMPTGRAPH_BIN:-promptgraph} mcp`. `promptgraph` must be on `PATH`, or `PROMPTGRAPH_BIN` must point to `packages/server/dist/cli/index.js`.
- Skills: `design-graph` (turn a task into a graph: decomposition, lanes, merge, checks, loops, prompts that work on their own; `references/patterns.md` holds complete graphs, validated by a test), `run-graph` (confirm, start, supervise, handle each attention state, report), `review-run` (explain a run from its report and suggest changes to the graph).

### 19.5 Setup guide in the UI

The header has a **Claude Code** button that opens a wizard with five steps: connect (plugin or MCP only, with copy buttons for the commands, and `PROMPTGRAPH_BIN` for a plugin that cannot find `promptgraph`), check (`POST /api/claude-setup/check` runs `claude mcp list` and looks for a `promptgraph` entry), skills (what each skill does and example requests), tools (grouped by purpose), and prompts to try.

- `GET /api/claude-setup` derives the commands from the running server: the CLI entry (`process.argv[1]`), the Node binary, this repository, and whether the checkout bundles the plugin (`.claude-plugin/marketplace.json` two levels above the server package). No state is stored.
- The skill and tool lists are the catalog in `packages/shared/src/mcp-guide.ts`. A test checks that the catalog names are exactly the registered MCP tools and that every skill has a `SKILL.md`, so the wizard cannot describe a tool that does not exist.
- The check only reads the output of `claude mcp list`; it does not install anything.

---

## 20. Chat panel

A panel next to the canvas where the user talks to Claude Code about the graph on screen: "I want to build a landing page with X, Y, Z" produces a graph; "remove this node", "simplify this", "add a lint step after this one" edit it, and the canvas updates live. The chat is a background Claude Code session in the repository's main checkout with the promptgraph plugin (MCP server + skills, §19) connected, so it changes graphs through the same REST API as every other client.

```
Browser                                   promptgraph server                          claude -p (stream-json)
 Chat panel ──WS chat:send{text,context}──► ChatManager ──stdin: user turn (JSON)──────► one process per session
            ◄──WS chat:item / chat:delta ── normaliser ◄──stdout: NDJSON lines ────────  cwd = repo root
            ◄──WS chat:status / session ──  permission bridge ◄─control_request can_use_tool
            ──WS chat:permission──────────►                ──control_response allow/deny►
 Canvas    ◄──WS graphs:changed ────────── graph store ◄──REST PUT /api/graphs/:id ──── promptgraph mcp (patch_graph, save_graph)
```

### 20.1 Transport

The server spawns `claude` with `child_process` (pipes, no PTY) in structured streaming mode. One long-lived process handles many turns: the server writes one JSON line per user turn to stdin and reads NDJSON from stdout until the turn's `result` line.

This does not break invariant 1 (never parse the TUI): there is no TUI. `--output-format stream-json` is structured CLI output (system/init, stream_event deltas, assistant and user messages, result, control requests), parsed per line with lenient zod schemas; unknown line types and fields are ignored. Node runs keep using the interactive PTY (§7), because there the user wants the real terminal; the chat wants a message view.

### 20.2 Spawn

```bash
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  --session-id <uuid>                 # new session (we generate it); --resume <id> after the process exited
  --name "pg:chat/<title>" \
  --permission-mode default --permission-prompt-tool stdio \
  --plugin-dir <bundled plugins/promptgraph>   # or --mcp-config '<inline JSON>' (below)
  --append-system-prompt <CHAT_SYSTEM_PROMPT> \
  --disallowedTools AskUserQuestion \
  --allowedTools <non-destructive promptgraph MCP tools> \
  [--model <m>]
```

- Env: `childEnv()` / `claudeBin()` as for headless calls, plus `PROMPTGRAPH_REPO=<repo root>` (the MCP server finds this server) and `PROMPTGRAPH_BIN` (the plugin's `.mcp.json` runs `${PROMPTGRAPH_BIN:-promptgraph} mcp`; it is set to the built CLI, derived like the setup wizard does, §19.5).
- With the plugin, MCP tools are named `mcp__plugin_promptgraph_promptgraph__<tool>` (server `plugin:promptgraph:promptgraph`). When the running server does not bundle the plugin, `--mcp-config` registers `{"mcpServers":{"promptgraph":{"command":<node>,"args":[<cli entry>,"mcp"],"env":{…}}}}` (tools `mcp__promptgraph__<tool>`); there are no skills then, and `chat:status` carries a warning.
- `AskUserQuestion` is disallowed: in stream-json mode it arrives as a `can_use_tool` prompt the panel cannot answer, so the system prompt has Claude ask in plain text instead.
- No built-in tool is pre-allowed. In `default` mode Claude Code reads inside the cwd (the repository) without asking; a bare `Read` / `Grep` / `Glob` / `LS` allow rule would also silence the prompt for reads outside it (`~/.ssh`, `~/.promptgraph` with the session token, other repositories), and the pre-allowed `save_graph` / `patch_graph` could then copy what was read into a committed graph file without any prompt.
- `bypassPermissions` is never used (invariant 5). Destructive MCP tools (`delete_graph`, `cancel_run`, `cleanup_run`) and every write or shell tool are not pre-allowed, so they go through the permission card (§20.4).
- `CHAT_SYSTEM_PROMPT` (server chat module) tells Claude where it runs: the user sees the graph live; each message starts with a context block (§20.3); use the promptgraph MCP tools (`save_graph` for new graphs, `patch_graph` for edits, keeping ids and positions) and the `design-graph` skill; never call `start_server` or `open_ui`; never approve gates; ask before destructive tools; do not edit repository files or run commands unless asked, because real work happens in graph runs; keep replies short and say what changed in the graph.

### 20.3 Context block

Every `chat:send` carries a `ChatContext` (`graphId | null`, `graphName?`, `selectedNodeIds`, `selectedEdgeIds`, `runId | null`, `readOnly`). The server prepends it to the user content, followed by a blank line:

```
<promptgraph-context graph="landing" selected-nodes="n1,n2" selected-edges="" run="none" read-only="false" />

remove this node
```

`buildChatContextBlock` / `withChatContext` (`packages/shared/src/chat.ts`) build it; attribute values are escaped. "This node" means the selection. The UI shows only the user's text (`stripChatContext` removes the block from history rebuilt from a transcript). Before sending, the web flushes the editor's pending autosave so Claude reads the graph the user sees.

### 20.4 Permissions

With `--permission-prompt-tool stdio`, each permission prompt arrives as a `control_request` (`subtype: "can_use_tool"`, tool name, input, description, blocked path). The server emits a `permission_request` item and the status `waiting_permission`; the UI shows a card with Allow / Deny, and `chat:permission` answers with a `control_response` (`allow` with the unchanged input, or `deny` with a message). A prompt still open when the turn is interrupted or the process exits is resolved with `by: "interrupt"` or `"exit"`. Parallel tool calls can open several prompts at once: the server keeps all of them (the session detail lists them oldest first) and the panel shows them one at a time, oldest first, with the number still waiting.

### 20.5 Lifecycle

- One `ChatSession` per chat; its process is spawned lazily on the first `chat:send`, and respawned with `--resume <id>` after it exited.
- At most one turn is in flight per process. Claude Code merges user lines written during a running turn into that turn and ends them with a single `result` (verified with 2.1.318), so the server keeps a FIFO of turns sent while one runs (another tab, a double submit) and writes the next one only after the previous `result`.
- `chat:interrupt` writes a `control_request` `interrupt` and drops the queued turns; the running turn then ends with a `result` of subtype `error_during_execution`.
- Deleting a session detaches its process before stopping it: output still in the pipe is ignored, so it can never touch the deleted row or bring the session back in the UI. A line that fails to apply is logged and never thrown out of the stream listener.
- Idle timeout: 15 minutes without a turn kills the process (the session resumes on the next message).
- Server shutdown: stdin is closed, then SIGTERM after 3 s.
- Statuses: `idle`, `starting`, `thinking`, `waiting_permission`, `exited`, `error`.

### 20.6 Items and WebSocket

The normaliser turns stream-json lines into `ChatItem`s (`user`, `assistant`, `tool_use` with a one-line summary, `tool_result` truncated to 2 000 characters, `permission_request`, `permission_resolved`, `result` with cost and duration, `error`, `notice` e.g. an MCP server that failed to connect). Text deltas stream as `chat:delta` and the final text arrives as an `assistant` item. Each delta carries its `offset` in the message text, and the session detail (`GET /api/chat/sessions/:id`) carries the text streamed so far for messages still streaming, so a client that opens the session or reconnects mid-stream joins the two without gaps or duplicates; a message whose beginning it never got shows "Receiving reply…" until the final item. On a reconnect the panel keeps the shown conversation on screen while it reloads, and a status received while the detail loads wins over the (older) status in the detail. All `chat:*` messages are broadcast (§12.2). REST: §12.1.

### 20.7 Graph patches

`GraphPatchOpSchema` (`packages/shared/src/graph-patch.ts`) is a list of ops on node ids:

| Op | Effect |
|---|---|
| `add_node {node}` | New node; `id` derived from the label (or type) when absent, `position` placed when absent |
| `update_node {id, label?, position?, onError?, config?}` | Shallow merge into `config` (a key set to `null` is removed); `onError: null` clears it |
| `remove_node {id, reconnect?}` | Removes the node and its edges; by default bridges each predecessor to each success successor (outgoing success edges on port `out`), keeping the predecessor's port and condition, and a loop on the successor edge. Failure, `always` and condition-branch edges of the removed node are dropped with it, so a handler never turns into a success branch of the predecessor |
| `connect {source, target, sourcePort?, when?, loop?, id?}` | Adds an edge (id derived from the endpoints when absent) |
| `disconnect {edgeId} \| {source, target, sourcePort?}` | Removes one edge |
| `insert_after {after, node, port?}` | The new node takes over the outgoing success edges of `after` on `port` (default `out`); failure, `always` and loop edges stay on `after`; `after` → new is added |
| `insert_before {before, node}` | The new node takes over every incoming edge of `before`; new → `before` is added |

`applyGraphPatch(graph, ops)` is pure: it applies the ops in order to a copy, places new nodes without a position (below their first placed predecessor — to its right when reached through a failure edge —, else above their first successor, moved right until they do not overlap; the layered layout of §19.3 when every node is new), parses the result with `GraphSchema`, and returns the graph with the added / removed / updated node and edge ids. An op that cannot apply throws `GraphPatchError` (code, op index, message). A config field that the node type does not have is an error (`invalid_node`, listing the expected fields), because the config schemas would otherwise drop it and the op would report success without changing anything. Existing nodes keep their ids and positions. Structural rules are left to `validateGraph`, whose result `patch_graph` returns.

Optimistic concurrency: `PUT /api/graphs/:id?baseHash=<hash>` (`SaveGraphQuerySchema`) refuses the save with 409 `graph_conflict` when the file's hash changed since Claude read it. The web editor's autosave also sends the last hash it knows, so a patch saved while a local edit was pending is never overwritten: the 409 shows the "changed outside the editor" banner (reload, or keep the local edits, which saves once without `baseHash`). A `graphs:changed` that arrives while an editor save is pending or in flight is checked again once the save settles.

### 20.8 Persistence

Session metadata lives in the `chat_sessions` table (§11.2): id (= Claude session id), title (first user message, truncated), timestamps, total cost, model. While the server runs, each session keeps its normalised item log in memory. A session opened after a restart rebuilds its items from the Claude transcript (`~/.claude/projects/<cwd with non-alphanumerics replaced by "-">/<sessionId>.jsonl`); a missing transcript gives an empty history. Deleting a session removes the metadata and kills the process; the transcript stays on disk.

### 20.9 External changes and undo

When the editor reloads a graph changed outside it (`graphs:changed` from the chat, the MCP server or a file edit), it keeps the previous version, highlights the added and updated nodes for a few seconds, and shows "Graph updated outside the editor · Undo"; Undo (the banner's button, or the canvas Undo of §13) saves the previous version back (with `baseHash`). When the Undo fails (the graph changed again, or a run started), the editor reloads the graph on disk so the next edit cannot write a stale version back. Before a chat message is sent, a pending autosave is flushed; if the graph on screen still could not be saved, the message is not sent.

### 20.10 Risks

- The stream-json input format and the control protocol (`can_use_tool`, `interrupt`) are only partly documented; they were verified against Claude Code 2.1.318 and may change. The parser is lenient and ignores unknown lines; tests replay recorded lines through an injected spawner.
- If the promptgraph plugin is also installed globally, `--plugin-dir` may load it twice and Claude may see the MCP server under two names. Pre-allowed tools are listed by their full names, so the duplicate's tools still ask for permission.
- The chat runs in the main checkout with the user's permissions. Writes and commands ask first, and the system prompt keeps Claude to graph work unless the user asks otherwise.

---

## 21. Voice dictation

The chat composer (§20) accepts dictation: the user speaks, sees the transcript appear, reviews it and sends it with Enter. The UX copies Claude Code's `/voice`; the transcription is local, done by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`) run by the promptgraph server.

### 21.1 Why not Claude Code's voice service

Claude Code's `/voice` streams audio to a private, undocumented Anthropic speech-to-text endpoint authenticated with the claude.ai OAuth token. promptgraph does not read that token (it only spawns `claude`), the endpoint and its protocol can change without notice, and using it would send audio off the machine through a path the user never configured for this tool. The browser Web Speech API is not used either: in Chromium it uploads the audio to Google. whisper.cpp keeps everything local, works offline, and is a single binary plus a model file the user installs.

### 21.2 Architecture

```
Browser (chat composer)                         promptgraph server                       whisper.cpp
 mic ─getUserMedia─► AudioWorklet (mono, ~50 ms) WS hub
                     main thread (pcm.ts):     ── binary frame ──► VoiceSession (one per WS client)
                     → 16 kHz Int16, ~100 ms       (PCM)            PCM buffer in memory (≤ 2 min)
                     chunks, RMS level
 useDictation ──WS voice:start{voiceId,…}──────►                     every ~2 s of new audio, if idle:
              ──WS voice:stop / voice:cancel──►                        write temp WAV (0600) ─────────► whisper-cli -m <model> -f <wav>
              ◄─WS voice:partial{text}─────────                        cleanWhisperText(stdout) ◄─────── -l <lang> -nt -np [-t n] [--prompt]
              ◄─WS voice:final{text} / voice:error                     delete WAV
 composer: partial shown dimmed at the cursor; final inserted at the cursor; Enter sends (§20)
 GET /api/voice ◄──────────────────────────────── VoiceService (probe: binary, model, `--help` smoke; cached 5 s, ?refresh=1)
```

- `packages/shared/src/voice.ts`: settings, `VoiceStatus`, the `voice:*` messages, limits and the pure helpers (`sanitizeKeyterms`, `cleanWhisperText`, `claudeLanguageToWhisper`, `resolveVoicePreferences`, `findVoiceModel`).
- Server `packages/server/src/voice/`: `VoiceService` (probe, status, global concurrency) and `VoiceSession` (one recording).
- Web `src/lib/voice/`: a plain-JS AudioWorklet (`pcm-capture.worklet.js`, emitted by Vite as a separate asset, never inlined) that only mixes to mono and posts Float32 blocks; resampling to 16 kHz Int16, the 100 ms framing and the RMS level run on the main thread in `pcm.ts` (plain TS, unit-tested). Then the `useDictation` hook, the `voice-store` state machine and the mic button in the chat composer.

### 21.3 Configuration and defaults

`AppSettings.voice` (`~/.promptgraph/settings.json`, Settings → Voice dictation): `whisperBin?`, `model?` (absolute paths), `mode?` (`hold` | `tap`), `language?` (a whisper code or `auto`), `autoSubmit?`, `threads?`. An absent field means "use the default"; a settings file without `voice` stays valid. `PUT /api/settings` replaces the `voice` object as a whole. Reading the file is lenient per field: an invalid value (a hand-edited `"es-ES"` language, a `~/…` path) falls back to its default on its own, so it never resets the other settings (which the next PUT would then write over the file).

| Field | Resolution (first that applies) |
|---|---|
| binary | `voice.whisperBin` > `whisper-cli` on PATH > `whisper-cpp` on PATH |
| model | `voice.model` > first `ggml-*.bin` in `~/.promptgraph/models` (VAD models excluded; small, base, medium, large-v3-turbo first, then by name) > first of `~/whisper.cpp/models/ggml-{small,base,medium,large-v3-turbo}*.bin`, in that order |
| mode | `voice.mode` > Claude Code `voice.mode` > `hold` |
| language | `voice.language` > Claude Code top-level `language` mapped to a whisper code (`"spanish"`, `"Español"`, `"es-ES"` → `es`; unknown → absent) > `auto` |
| autoSubmit | `voice.autoSubmit` > Claude Code `voice.autoSubmit` > `false` |

Claude Code's settings are read from `~/.claude/settings.json` (read-only; a missing or invalid file, or a field of the wrong type, is ignored; the legacy `voiceEnabled` is read but does not gate promptgraph's dictation). `VoiceStatus.defaultsFrom` says where each of mode, language and autoSubmit came from (`promptgraph` | `claude` | `fallback`).

`GET /api/voice` returns `available` and, when false, `reason`: `binary_not_found`, `model_not_found` or `binary_failed` (the `--help` smoke test failed), plus the setup lines. promptgraph never downloads binaries or models; the UI shows:

```bash
sudo apt install cmake
git clone https://github.com/ggml-org/whisper.cpp ~/whisper.cpp && cd ~/whisper.cpp
cmake -B build && cmake --build build -j --config Release
sh ./models/download-ggml-model.sh small
# Then set the whisper binary to ~/whisper.cpp/build/bin/whisper-cli (or put it on PATH);
# the model is auto-detected in ~/whisper.cpp/models.
```

### 21.4 Protocol

Client → server: `voice:start {voiceId, sampleRate: 16000, keyterms?, language?}`, then binary frames of little-endian Int16 mono PCM at 16 kHz (about 100 ms each), then `voice:stop {voiceId}` or `voice:cancel {voiceId}`. Server → client: `voice:partial {voiceId, text}`, then exactly one terminal message, `voice:final {voiceId, text, truncated?, notice?}` or `voice:error {voiceId, code, message}`; nothing after `voice:cancel`. `notice` is set when the final pass failed and the server fell back to the last good partial; the client shows it and never auto-submits that text.

- One active session per WS client. A binary frame with no active session is ignored; a new `voice:start` cancels the previous session silently. Closing the socket cancels it.
- `voice:partial` carries the transcript of all audio so far and replaces the previous one.
- `keyterms` (at most 50, each at most 60 characters; the web sends "promptgraph", the node type names and the labels of the open graph's nodes) are cleaned with `sanitizeKeyterms` and passed as `--prompt "<a, b, c>"` to bias the vocabulary.
- Error codes: `unavailable` (no binary/model), `too_long` (the wall-clock watchdog, 150 s after `voice:start`, ended a session that never stopped), `failed` (the final pass exited non-zero or timed out with no partial to fall back to, an oversized frame), `busy` (the global transcription slot is taken and the queue is full), `cancelled` (the server ended the session, e.g. shutdown).
- At 2 minutes of audio (3 840 000 bytes) the server stops by itself and sends `voice:final` with `truncated: true`; later frames are ignored.

### 21.5 Server

- `VoiceSession` keeps the PCM in memory. While recording, after each ~2 s of new audio and when no pass is running, it writes a WAV (44-byte RIFF header, PCM16 mono 16 kHz) to a mode-0600 temp file in the server's own directory `~/.promptgraph/tmp/voice-<pid>-<random>/` (mode 0700), runs `<bin> -m <model> -f <wav> -l <lang> -nt -np [-t <threads>] [--prompt <keyterms>]` with `child_process.spawn` (argument array, no shell), cleans stdout with `cleanWhisperText` (drops `[BLANK_AUDIO]`, `[Music]`, `(silence)`, timestamps; joins lines), sends `voice:partial` and deletes the file.
- A partial pass that fails or times out never ends the recording: partials are a preview, the next partial or the final pass retries.
- On stop it waits for a running pass, runs a final pass on all the audio, sends `voice:final` and drops the buffer. If the final pass fails but an earlier partial succeeded, `voice:final` carries that partial with a `notice` instead of a `voice:error`. Cancel and socket close kill the child, delete the file and drop the buffer.
- At most one whisper process per session and one per server process; other passes queue (a partial pass is skipped rather than queued twice), a session that cannot get the slot in time gets `busy`. Each pass times out after 60 s. Several servers (one per repository, §19.1) each have their own slot, so two dictations in two servers can run whisper at the same time; that is accepted (dictation is interactive and rarely concurrent) rather than adding a cross-process lock.
- Temp files: several servers share `~/.promptgraph/tmp`, so each one writes and deletes only inside its own `voice-<pid>-<random>/` directory. At startup and on shutdown a server also removes the directories of servers whose pid is no longer running (audio left by a crash or SIGKILL mid-pass) and loose `voice-*.wav` older than two pass timeouts; it never touches the directory of a live server. All removals are best effort and never throw.
- Graceful shutdown kills the whisper children and removes the server's temp directory.

### 21.6 UX parity with Claude Code

| Claude Code `/voice` | promptgraph |
|---|---|
| `hold`: hold Space while speaking, release ends | Same, when the composer is empty; also press-and-hold on the mic button |
| `tap`: Space starts/stops, only with an empty prompt | Same; click on the mic button toggles |
| — | Alt+Space starts/stops at any time, also with text in the composer |
| Interim text shown dimmed while speaking | Partial transcript shown dimmed at the insertion point (not part of the textarea value) |
| Final transcript inserted at the cursor, not submitted | Same (a space is added when needed); Enter sends |
| `voice.autoSubmit` | Same setting, default taken from Claude Code |
| Esc cancels and restores the prompt | Same |
| Stops after 15 s of silence or 2 min | Same (silence detected in the browser from the RMS level; the 2 min cap enforced by the server too) |
| Language from the `language` setting | Same, mapped to a whisper code; overridable |
| Anthropic speech-to-text service | Local whisper.cpp |

The mic button shows a level meter and the elapsed time, has `aria-pressed` and an `aria-live` status, and is disabled while the chat is not usable. When dictation is unavailable it opens a popover with the reason, the setup lines (with copy buttons) and "Check again". A denied microphone permission shows a clear message. The microphone is released (tracks stopped, AudioContext closed) on stop, cancel and unmount. On stop the capture is drained first: the worklet posts the block it is filling and acknowledges, the frames still queued on its port and the resampler's last partial period are sent, and only then `voice:stop` goes out, so a hold released right at the end of a word keeps its last syllable (cancel releases at once). A microphone lost mid-recording (track `ended`, AudioContext closed or interrupted) stops the recording with a notice instead of waiting for the silence timeout.

Keyboard and pointer details: a mic-button hold captures the pointer (and a window `pointerup` listener backs it up), so releasing off the button still stops. Esc and Alt+Space work wherever the focus is while dictating (e.g. on the mic button after a keyboard activation). Releasing a held Space, or the window losing focus, while the browser shows the microphone permission prompt keeps the recording going as tap instead of cancelling it. With autoSubmit on, a transcript that arrives while Claude is still replying stays in the composer with a "not sent" notice. While the chat is disconnected the mic button is `aria-disabled` (not `disabled`), so its tooltip and screen-reader description still say why.

### 21.7 Privacy

Audio stays on the machine: browser → `127.0.0.1` WebSocket (token-protected, §14) → memory → a mode-0600 temp WAV, in the server's own 0700 directory, deleted right after each pass → whisper.cpp. WAVs left by a server that crashed mid-pass are removed when any later server starts or shuts down. Nothing is persisted, and neither audio nor transcripts are logged; the transcript only becomes data when the user sends it as a chat message.

### 21.8 Limits and risks

- Partial passes re-transcribe all the audio so far on the CPU, so their latency grows with the recording (a few seconds for a minute of audio with `small` on a laptop). A pass only starts when the previous one finished, so partials lag rather than pile up; the final pass on stop is the one that counts. Smaller models (`base`) are faster and less accurate; `threads` tunes the CPU use.
- Quality depends on the model: `small` is a reasonable default for Spanish and English; the `.en` models are English only. whisper can hallucinate short phrases on silence; `cleanWhisperText` only removes the bracketed artefacts.
- whisper.cpp's CLI flags and output are not a stable API; the `--help` smoke test catches a broken binary, and tests use a fake `whisper-cli`.
- Measured with a real whisper.cpp build (`ggml-base`, CPU, the 11 s `jfk.wav` sample streamed in real time over the WS): partials every ~2 s, and 1.5–2 s from `voice:stop` to `voice:final`. The final transcript matched the reference sentence; cancelling mid-pass left no temp WAV and no whisper process.
- A language that does not match the speech degrades the result (with `language: "es"` inherited from Claude Code, English audio came back with a stray leading word). Users who dictate in several languages should set `auto`.
