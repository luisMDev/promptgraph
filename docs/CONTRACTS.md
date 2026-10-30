# promptgraph — Internal contracts

> Audience: the builders implementing M1–M6 in parallel. `DESIGN.md` is the product spec, `SPIKE.md`
> overrides it where they differ. This file fixes **module boundaries, file paths and interfaces**.
> Every server file listed here exists as a compiling stub (`throw new Error("not implemented")`) whose
> doc comment is part of the contract. Change a signature only together with all its callers and this file.

## 1. Workspace

```
package.json            scripts: build (pnpm -r build), dev, typecheck (pnpm -r typecheck), test (vitest run)
pnpm-workspace.yaml     packages/*, onlyBuiltDependencies: node-pty, better-sqlite3, esbuild
tsconfig.base.json      strict, NodeNext, verbatimModuleSyntax, noUncheckedIndexedAccess
vitest.config.ts        one root config; tests in packages/*/test/**/*.test.ts(x) and src/**/*.test.ts(x)
packages/shared         @promptgraph/shared — zod schemas, types, validator, topology, pricing, WS protocol
packages/server         @promptgraph/server — bin `promptgraph` (dist/cli/index.js), assets/pg-hook
packages/web            @promptgraph/web — React 19 + Vite + Tailwind v4 (built to packages/web/dist)
```

All dependencies for M1–M6 are installed. **Do not run `pnpm add`**; if something is truly missing, say so.

| Package | Runtime deps | Dev deps |
|---|---|---|
| shared | zod 4 | typescript 7, @types/node |
| server | hono, @hono/node-server, ws, node-pty, better-sqlite3, zod, nanoid, open | tsx, @types/ws, @types/better-sqlite3, @types/node |
| web | react 19, react-dom, @xyflow/react, @xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links, zustand, diff2html | vite 8, @vitejs/plugin-react, tailwindcss 4, @tailwindcss/vite, jsdom, @testing-library/react |
| root | — | vitest 5, typescript 7 |

**Resolving `@promptgraph/shared`.** Its `exports` has a `source` condition → `src/index.ts`, `types` →
`dist/index.d.ts`, `default` → `dist/index.js`. Typecheck (`customConditions: ["source"]`), vitest, vite and
`tsx --conditions=source` (server `dev` script) read the TS source directly; the production build
(`pnpm build`, topological) compiles shared first and the server imports its `dist`.

Notes: zod is **v4** (`z.looseObject`, `.prefault()`, `z.input`/`z.infer`). TypeScript is 7 (native `tsc`).
Imports inside shared/server use `.js` extensions (NodeNext). Web uses bundler resolution, no extensions.

## 2. Shared package (`packages/shared/src`)

| File | Exports (main) |
|---|---|
| `graph.ts` | `GraphSchema`, `NodeSchema` (discriminated by `type`), per-type `*ConfigSchema` with §6.1 defaults, `EdgeSchema` (`sourcePort`, Phase-2 `when`/`loop` optional), `GraphSettingsSchema` (incl. `autoTrustWorktrees` default true, `allowPrWithoutApproval` default false), `CompletionPolicySchema`, types `Graph`, `GraphInput`, `GraphNode`, `GraphNodeOf<T>`, `ClaudeNode`, `GraphEdge`, `NodeConfigMap`; helpers `defaultNodeConfig`, `resolveBranchPrefix`, `slugifyGraphId`, `edgeWhen`, `edgeMatches`, `NodeOutcome`, `compareCanvasOrder`, `createEmptyGraph`, `isClaudeNode` |
| `status.ts` | `NodeStatus` (§8.2; `ready` = queued), `RunStatus` (§8.3), `LaneStatus`, `ACTIVE_/FINAL_/ATTENTION_NODE_STATUSES`, `isFinalRunStatus` |
| `run.ts` | `TokenUsage`, `NodeRunOutput`, `WaitingReason`, `NodeRun`, `Lane`, `RunSummary`, `Run` (= summary + `graphSnapshot`), `RunDetail`, `RunEvent` |
| `pricing.ts` | `PRICE_TABLE`, `MODEL_ALIASES`, `priceFor`, `RawUsage`, `costFromUsage`, `emptyUsage`, `accumulateUsage`, `sumUsage`, `formatCostUsd` |
| `hooks.ts` | `HookEvent` (`session-start`/`activity`/`notification`/`stop`), `CLAUDE_HOOK_FOR_EVENT`, payload schemas, `HookPayloadMap`, `describeToolActivity` |
| `headless.ts` | `HeadlessResultSchema` (real `claude -p --output-format json` envelope), `GENERATED_MESSAGE_JSON_SCHEMA`, `JUDGE_JSON_SCHEMA` |
| `api.ts` | REST request/response schemas (§7 below), `AppSettingsSchema`, `API` path builders, `TOKEN_COOKIE` |
| `ws.ts` | `ServerMessageSchema`, `ClientMessageSchema` (discriminated unions), `encodeBase64`/`decodeBase64` |
| `topology.ts` | `buildTopology`, `findRoots`, `topologicalOrder`, `findCycle`, `ancestors`, `descendants`, `branchKey`, `edgesMutuallyExclusive`, `computeLanePlan` → `LanePlan {lanes: PlannedLane[], laneOf, mergeSources}` |
| `validation/` | `validateGraph(graph, {phase})` → `ValidationResult {errors, warnings}` of `ValidationIssue {code, message, nodeId?, edgeId?}` |

Semantics fixed here (do not re-implement elsewhere):

- **Edge matching** `edgeMatches(edge, outcome)`: `when` defaults to `failure` for `sourcePort:"error"`, else `success`;
  `true`/`false` ports match `outcome.port`. Phase 1 graphs only contain `out` + success edges.
- **Lane plan** `computeLanePlan` (§9.2): root lanes are created first in canvas order (`main`, `l2`, `l3`…),
  forks get the next ids in topological order. Branch-key groups (`out`/`true`/`false`/`error`) are mutually
  exclusive and never fork. `mergeSources.get(mergeNodeId)` = lanes to merge, in canvas order of the inputs
  (§18 Q4: sequential pairwise, no octopus).
- **Validation phase**: the server passes `SUPPORTED_PHASE` (`config/version.ts`, 1 until M5). Phase 1 rejects
  condition nodes, non-success edges and loops (`phase2_unsupported`) and every non-merge join (`invalid_join`).
  Phase 2 allows joins whose inputs are pairwise `edgesMutuallyExclusive`.
- **Warnings** (never block Run): `uncommitted_before_pr`, `uncommitted_before_merge` (§18 Q1 — the engine
  checkpoints automatically), `empty_label`, `condition_input`.
- **Cost**: `costFromUsage(model, rawUsage)` — cache writes without a 5m/1h split are priced as 1h (what
  Claude Code uses); verified exactly against a real envelope (`total_cost_usd` 0.1756). Unknown model → 0.

## 3. Conventions

- Timestamps: epoch **milliseconds** everywhere (DB, DTOs).
- Ids (`server/src/util/ids.ts`): `newId()` 12 `[0-9a-z]` for runs, node runs, ptys; `newShortId()` 4 hex for
  branch names; `newSessionId()` UUID for `--session-id`.
- **PTY ids**: a node's main PTY id **is its nodeRunId** (`NodeRun.ptyId = nodeRun.id`); workspace setup
  `setup-<nodeRunId>`; merge-pause shell `shell-<nodeRunId>`; Reopen session `reopen-<id>`.
  Logs: `~/.promptgraph/runs/<runId>/<ptyId>.log` (`ptyLogPath`).
- Paths (`config/paths.ts`): `PG_HOME` overrides `~/.promptgraph`; `state.db`, `settings.json`, `runs/`,
  `worktrees/<repo-name>/<run-id>/<lane-id>/`, `bin/pg-hook`. Graph files: `<repo>/.promptgraph/graphs/<id>.json`.
- Env (`config/child-env.ts`): `claudeBin()` = `PG_CLAUDE_BIN` or `claude`. **Every** child process gets
  `childEnv(extra)`: strips `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_REMOTE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_TEE_SDK_STDOUT`,
  `CLAUDE_CODE_SYNC_SESSION_REFS`, `*HERMETIC*`; sets `TERM=xterm-256color`.
- Claude config file: `claudeConfigFile(env)` = `$CLAUDE_CONFIG_DIR/.claude.json` else `~/.claude.json`.
- Other env: `PG_WEB_DIST` (static dir override), `PG_PORT` (vite proxy target in dev).
- Text helpers (`util/text.ts`): `stripAnsi`, `tailLines`, `truncate`.
- No module except the **engine** writes run/node-run/lane **status**; runners go through `ctx.update`.

## 4. Server module map (`packages/server/src`)

| Path | Exports | Milestone |
|---|---|---|
| `config/paths.ts` ✅ | `pgHome`, `getPaths` → `PgPaths`, `runDir`, `ptyLogPath`, `hooksSettingsPath`, `worktreePath`, `graphsDir`, `claudeConfigFile`, `PG_HOOK_SOURCE`, `webDistDir` | done |
| `config/child-env.ts` ✅ | `claudeBin`, `childEnv`, `PgHookEnv` | done |
| `config/version.ts` ✅ | `VERSION`, `SUPPORTED_PHASE` | done (M5 bumps phase) |
| `config/app-settings.ts` | `AppSettingsStore {get, update}` | M2 |
| `events/bus.ts` ✅ | `EventBus`, `BusEvents`, `AttentionKind` | done |
| `util/ids.ts`, `util/text.ts` ✅ | see §3 | done |
| `store/schema.ts` ✅ | `MIGRATIONS` (user_version based) | done |
| `store/store.ts` | `openDatabase`, `Store` DAO, `NewRun`, `RunPatch`, `NewLane`, `LanePatch`, `NewNodeRun`, `NodeRunPatch` | M1 |
| `graphs/graph-store.ts` | `GraphStore {ensureDir, list, get, save, delete, watch}`, `hashContent`, `serializeGraph`, `GraphNotFoundError`, `GraphLoadError` | M1 |
| `git/exec.ts` ✅ | `git`, `gitOk`, `GitError` | M1 |
| `git/repo.ts` ✅ | `resolveRepoRoot`, `currentBranch`, `listBranches`, `revParse`, `isDirty` | M1 |
| `pty/ring-buffer.ts` | `RingBuffer`, `PTY_RING_BYTES` (2 MB) | M1 |
| `pty/pty-manager.ts` | `PtyManager`, `PtyHandle`, `SpawnPtyOptions`, `PtyAttachResult` | M1 |
| `hooks/hook-router.ts` | `HookRouter {register, dispatch}`, `HookMessage` | M1 |
| `runners/types.ts` ✅ | `Runner`, `RunnerContext`, `RunnerResult`, `NodeControls`, `NodeExecution`, `PredecessorOutput`, `RunnerRegistry` | done |
| `runners/claude/args.ts` | `buildClaudeArgs`, `toCliPermissionMode`, `ClaudeLaunchSpec` | M1 |
| `runners/claude/context.ts` | `buildInitialMessage`, `markerInstruction`, `INTERRUPTED_MESSAGE`, `CONTEXT_OUTPUT_LIMIT` | M1 |
| `runners/claude/hooks-settings.ts` | `buildHooksSettings`, `writeHooksSettings` | M1 |
| `runners/claude/pg-hook.ts` | `installPgHook` | M1 |
| `runners/claude/trust.ts` | `preTrustDirectory`, `TRUST_DIALOG_PATTERN` | M1 |
| `runners/claude/transcript.ts` | `lastAssistantText`, `waitForLastAssistantText`, `usageFromTranscript` | M1 (usage M2) |
| `runners/claude/completion.ts` | `CompletionController` | M1 |
| `runners/claude/headless.ts` | `runHeadless` | M1 (commit messages) |
| `runners/claude/claude-runner.ts` | `ClaudeRunner {start, reopen}`, `ClaudeRunnerDeps`, `ServerEndpoint` | M1 (reopen M2) |
| `runners/shell-runner.ts` | `ShellRunner`, `SHELL_TAIL_LINES` | M1 |
| `runners/git/messages.ts` | `generateMessage` | M1 (commit), M4 (pr) |
| `runners/git/commit-runner.ts` | `CommitRunner` | M1 |
| `runners/git/merge-runner.ts` | `MergeRunner`, `conflictPrompt` | M3 |
| `runners/git/pr-runner.ts` | `PrRunner` | M4 |
| `runners/approval-runner.ts` | `ApprovalRunner` | M4 |
| `runners/condition-runner.ts` | `ConditionRunner` | M5 |
| `runners/registry.ts` | `createRunnerRegistry` | M1 (+ each milestone adds its runner) |
| `workspace/lane-manager.ts` | `LaneManager`, `RepoRef`, `MergeAttempt` | M1 (single lane) / M3 (forks, merge, cleanup) |
| `workspace/setup.ts` | `runWorkspaceSetup` | M3 |
| `engine/state.ts` ✅ | `NODE_TRANSITIONS`, `canTransition`, `assertTransition`, `RUN_TRANSITIONS` | done |
| `engine/activation.ts` | `ActivationTracker`, `ActivationDelta` | M1 (skips/dead paths M5, loops M6) |
| `engine/scheduler.ts` | `Scheduler`, `SchedulerItem` | M1 (cap matters from M3) |
| `engine/recovery.ts` | `markInterrupted` | M4 (crash resume) — M1 may implement early |
| `engine/engine.ts` | `Engine`, `EngineDeps`, `EngineError` | M1 |
| `notify/notifier.ts` | `Notifier`, `detectNotifyPlatform`, `sendDesktopNotification` | M2 |
| `commands/discover.ts` | `listSlashCommands` | M2 |
| `app/context.ts` | `AppContext`, `createAppContext` (composition root) | M1 |
| `http/auth.ts` | `tokenAuth`, `localhostOnly`, `isAuthorized` | M1 |
| `http/app.ts` | `createHttpApp` | M1 |
| `http/routes/{graphs,runs,node-runs,misc,hooks}.ts` | `register*Routes(app, ctx)` | M1 (routes added per milestone) |
| `http/static.ts` | `registerStatic` | M1 |
| `ws/hub.ts` | `WsHub {attach, close}` | M1 |
| `cli/args.ts` | `parseCliArgs`, `CliOptions`, `USAGE` | M1 |
| `cli/prereqs.ts` | `checkPrereqs` | M1 |
| `cli/server.ts` | `startServer` → `RunningServer {ctx, url, port, token, close}` | M1 |
| `cli/index.ts` | `main(argv)` bin entry (auto-runs; tests must not import it) | M1 |

✅ = implemented in the foundation (do not rewrite; extend if needed).

## 5. Event bus (`events/bus.ts`)

```ts
interface BusEvents {
  "run:update":     { run: RunSummary };            // engine, after any run change or derived counter/usage change
  "node:update":    { nodeRun: NodeRun };           // engine, after every persisted node-run change
  "lane:update":    { lane: Lane };                 // LaneManager / engine
  "pty:data":       { ptyId: string; data: Buffer }; // PtyManager
  "pty:exit":       { ptyId: string; code: number | null };
  "graphs:changed": { graphId: string };            // GraphStore (save/delete/watch)
  attention: { kind: "waiting_input" | "waiting_approval" | "idle"; nodeRun; nodeLabel; graphName; message: string | null };
}
bus.emit(name, payload); const off = bus.on(name, listener);
```

Consumers: `WsHub` forwards everything except `attention` (§8). `Notifier` consumes `attention` only.
The engine emits `attention` exactly once per transition **into** one of the three statuses.

## 6. Engine (`engine/engine.ts`) — lifecycle

Public API (all async except `getRun`, `activeRunForGraph`, `handleUserInput`):
`startRun(graphId) → RunDetail`, `getRun(runId)`, `cancelRun`, `cleanupRun`, `activeRunForGraph(graphId)`,
`done`, `fail(id, reason?)`, `retry`, `skip`, `setHold(id, hold)`, `submitApproval(id, ApprovalRequest)`,
`getApprovalInfo`, `getDiff`, `reopenSession`, `handleUserInput(ptyId)`, `recover()`, `shutdown()`.
Errors are `EngineError(code)`: `not_found`→404, `validation_failed`→422 (details = ValidationResult),
`run_active`→409, `invalid_state`→409, `load_error`→422.

**startRun**
1. `graphs.get(id)` (GraphLoadError → `load_error`); `validateGraph(graph, {phase})` errors → `validation_failed`.
   One active (running/paused) run per graph → else `run_active`.
2. `store.setKnownGraphHash(repo, id, hash)`; insert run (`status running`, snapshot, `graphHash`, `shortId`).
3. `computeLanePlan(snapshot)`; insert one `pending` NodeRun per node (iteration 0, attempt 0, `laneId` from plan).
4. Create root lanes (`LaneManager.createLane(run, planned, settings.baseBranch)`); M1 graphs have one lane.
5. `ActivationTracker.initialReady()` → node runs `ready` → `Scheduler.enqueue`.

**Starting a node** (Scheduler `onStart`): if its lane does not exist yet (fork, M3): checkpoint the parent lane
(§9.3), `createLane(run, planned, parentHead)`; if the lane is new and `settings.workspaceSetup` is set, run
`runWorkspaceSetup` (`laneSetup` running → succeeded/failed; failure fails the node). Then status `running`,
`startedAt`, build `RunnerContext` (predecessors = current node runs of direct predecessors, canvas order;
`previousAttempt`), `runners[node.type].start(ctx)`; missing runner → node failed "Node type not supported yet".
Before `pr` and `merge` nodes the engine checkpoints dirty lanes (§18 Q1; merge does it via LaneManager.merge).

**Finishing a node** (execution `result` settles):
- `succeeded` → status succeeded, output, `finishedAt`; outcome `{kind:"success", port: output.port}`.
- `failed` → status failed, error, output. If (Phase 2) a matching failure edge exists → outcome failure,
  flow continues. Else per `node.onError ?? "pause"`: `pause` → other branches keep running; when nothing
  else can progress the run becomes `paused`; `fail-run` → cancel the rest, run `failed`.
- `cancelled` → status cancelled.
- `Scheduler.release`; `tracker.complete(nodeId, outcome)` → newly ready → enqueue; dead paths → skipped.
- Run end: all node runs final and no queue → `succeeded` if every node succeeded/skipped, else `failed`;
  `finishedAt`; then `LaneManager.cleanup(runId, {keep: settings.keepWorktrees, failed})`.

**Manual controls** (§12.1): `done`/`fail`/`setHold`/`submitApproval` are forwarded to the live execution's
`NodeControls` (409 `invalid_state` if none). `retry` (failed/interrupted/cancelled): new NodeRun
`attempt+1`, same lane, `previousAttempt` set, run → running. `skip` (failed/interrupted/pending): status
`skipped`, `tracker.skipAsSuccess`, run → running if it was paused. `hold` persists `NodeRun.hold`.

**User input**: `PtyManager.onUserInput(ptyId)` → `Engine.handleUserInput` → `controls.userInput()`.

**Usage**: Claude runners put `output.usage` (partial output allowed while running). The engine emits
`run:update` whenever a node run's output changes so `RunSummary.usage` (sum) stays live.

**Recovery** (§8.6): `recover()` calls `markInterrupted(store)` and `lanes.prune()`. Interrupted runs are
`paused` with no in-memory state; the first retry/skip on such a run rebuilds it with
`ActivationTracker.restore` from the stored node runs and re-enqueues `pending` nodes whose inputs are resolved. Retrying an interrupted
Claude node resumes its session (`--resume <sessionId>` + `INTERRUPTED_MESSAGE`).

**Shutdown** (SIGINT, §4.5): `controls.cancel()` on every live execution concurrently (Claude: `/exit`, ≤3s,
kill), overall ≤5s, then `ptys.killAll()`; node runs → `interrupted`, runs → `paused`.

Helper modules: `ActivationTracker` (pure, §8.1), `Scheduler` (FIFO, `maxParallelClaude` for prompt/command,
uncapped otherwise; per-lane git serialisation is `LaneManager.withLaneLock`), `state.ts` transition table
(assert on every status write).

**Implementation notes (server-core, minimal extensions):**
- `GraphStore.setWriteGuard(fn)`: called before `save`/`delete`; the `Engine` constructor installs a guard that
  throws `EngineError("run_active")` (→ 409) while the graph has a running/paused run, so routes need no extra check.
- `Store` takes an optional clock (`new Store(db, now?)`) and adds `getLane(runId, laneId)`.
  `RunSummary.waitingInput` counts `waiting_input` **and** `idle` node runs; usage sums every attempt.
- `EngineDeps` adds optional `env` (base env for workspace setup, default `process.env`) and `stopTimeoutMs`
  (graceful-stop bound for cancel/shutdown, default 5000).
- `Scheduler.clear()`; `ActivationTracker.isResolved(nodeId)` and `readyUnresolved()` (used by restore/resume).
- Fork lanes are created (parent checkpoint → `headSha` → `createLane`) when the fork-after node resolves,
  **before** its successors are enqueued, so the lane-keeping successor cannot dirty the parent mid-checkpoint;
  `ensureLane` at node start remains the fallback (e.g. after a restart). Creation errors fail the lane's first node.
- Leaving `waiting_input` clears `waitingReason` unless the patch sets one. Status changes after a node settled
  (late hooks) are dropped from runner patches; final statuses from runners throw.
- Events written by the engine: `run.started`, `run.status`, `run.action`, `run.cleanup`, `run.cleanup_failed`,
  `lane.created`, `node.status`, `node.action`, `node.user_skip` (restore treats such skipped node runs as
  success; other `skipped` node runs are dead paths). Runner `ctx.event` types are free-form.
- Retry is refused (`invalid_state`) for non-latest attempts, finished runs, and failures already routed by a
  Phase-2 failure edge. Skip also accepts `ready` (queued) nodes. `setHold` works on any non-final node run.
- Run end: unhandled `failed`/`interrupted`/`cancelled` current node runs with nothing in flight → `paused`;
  all `succeeded`/`skipped`/handled-`failed` → `succeeded`; anything else stuck → `failed` "No node can make progress".

## 7. Runners (`runners/`)

Contract in `runners/types.ts`. A runner never writes final statuses; it returns a `RunnerResult`. While
running it may `ctx.update({status: "running" | "idle" | "waiting_input" | "waiting_approval", …})`.

**ClaudeRunner** (prompt, command; also used by MergeRunner for conflicts):
- Options: `node.config.X ?? settings.defaults.X` for model, effort, permissionMode, allowedTools, completion.
- `hooks.json` once per run at `hooksSettingsPath` with commands `'<binDir>/pg-hook' <event>` (§7.2).
- Spawn: `claudeBin()` with `buildClaudeArgs(spec)`, cwd = lane worktree, 120×40, env
  `childEnv({PG_PORT, PG_TOKEN, PG_NODE_RUN_ID})`, PTY id = nodeRun.id, `logPath = ptyLogPath(...)`.
  `spec.name = "pg:<graph-id>/<node-label>"`.
- Trust (SPIKE A5): `settings.autoTrustWorktrees` → `preTrustDirectory(worktreePath, env)` before spawn.
  Otherwise watch stripped PTY output for `TRUST_DIALOG_PATTERN` → `waiting_input {kind:"trust_dialog"}`.
- Hook handling via `HookRouter.register(nodeRunId, …)`:
  `session-start` → `{sessionId, transcriptPath}`, status running ·
  `activity` → `activity = describeToolActivity(p)`, waiting_input/idle → running ·
  `notification` → `waiting_input {kind:"notification", notificationType, message}` ·
  `stop` → text = `last_assistant_message` ?? `waitForLastAssistantText(transcript)`; `output = {text, usage:
  usageFromTranscript(transcript)}`; `CompletionController.onStop(text)`.
- Completion (`CompletionController`, §7.4): auto grace (user input cancels), manual → idle, marker → token
  check, hold forces manual for the current turn. `done()` from idle → success.
- Success → `"/exit\r"`, wait 3s, kill; PTY exit before success (and not cancelled) → failed.
- `reopen()` (M2): `claude --resume <sessionId>` in a new PTY `reopen-<id>` (not part of the run).

**ShellRunner**: `sh -c <run>` in a PTY (id = nodeRun.id); output `{exitCode, stdoutTail, timedOut?}`.

**CommitRunner / PrRunner / MergeRunner / ApprovalRunner / ConditionRunner**: see each file's doc comment.
Generated messages use `runHeadless` with `GENERATED_MESSAGE_JSON_SCHEMA` and read `structured_output`.

**Implementation notes (server-runners, minimal extensions):**
- Optional `env` (base env, default `process.env`) on `HeadlessOptions`, `GenerateMessageInput`, `ShellRunnerDeps`,
  `CommitRunnerDeps`, `RunnerRegistryDeps`; `detectNotifyPlatform(env?)`. `CommitRunner` needs only
  `lanes.withLaneLock`. `NotifierDeps` has test seams `detect?`/`send?`.
- `runners/git/checkpoint.ts` (new): `CHECKPOINT_PREFIX`, `checkpointMessage`, `isCheckpointMessage`,
  `checkpointIfDirty(cwd, label)` (what `LaneManager.checkpoint` should call under its lane lock) and
  `squashTarget(cwd, baseRef)`. `squashCheckpoints` soft-resets over trailing checkpoints but **never below
  `lane.baseRef`** (history shared with a parent lane stays intact).
- `CompletionController.onActivity()` (PreToolUse after idle/grace → running). Hold is remembered even when set
  before the controller exists and is seeded from `nodeRun.hold`.
- `resolveClaudeOptions(node, defaults)` and `describePredecessor(p)` are exported (merge/judge reuse).
- Notification `idle_prompt` is ignored after a Stop (the completion policy already decided); other
  notifications → `waiting_input`. `context:"resume"` with no same-lane Claude predecessor session → failed.
- Graceful stop writes `/exit`, then `\r` 100 ms later (verified with real Claude Code), waits 3 s, SIGTERM, SIGKILL.
- Pre-trust also trusts the directory's realpath and writes through a symlinked config; unparsable config → throws
  (node fails) instead of overwriting.
- `PtyManager`: spawning an id that is still live throws; `get()` also returns exited handles; exit `code` is null
  when killed by a signal. Reopen PTYs log to `ptyLogPath(paths, run.id, "reopen-<id>")` — the composition root's
  `resolveLogPath` must map those after a restart.
- Commit messages are generated from `ctx.predecessors` (the context has no other node runs).
- Real-claude test: `PG_REAL_CLAUDE=1 pnpm vitest run packages/server/test/claude-runner.real.test.ts`.

**Implementation notes (integration M1+M2):**
- `git/exec.ts`, `git/repo.ts`, `workspace/lane-manager.ts` and `workspace/setup.ts` are implemented (incl. M3's
  `merge`/`concludeMerge`/`abortMerge`). `git()` only opens stdin when `input` is given (no EPIPE on early exit).
- `LaneManager.diff` stages HEAD + all worktree changes into a throwaway index (`GIT_INDEX_FILE`) and diffs it
  against the merge-base, so untracked files show up without touching the lane's index.
- `LaneManager.cleanup` (§9.6) removes worktrees and deletes unpushed branches **only when they carry no commits
  of their own** (or the lane was merged). A run without a `pr` node keeps its branch (e.g. the commit node's work).
- `Engine.shutdown` also waits (bounded by `stopTimeoutMs`) for in-flight node chains (finish → advance →
  finalize/cleanup) so nothing writes to the store after the DB is closed.

## 8. HTTP & WebSocket

- Server binds `127.0.0.1:<port>`. Middleware order: `localhostOnly` (Host/Origin must be `127.0.0.1:<port>`
  or `localhost:<port>`, else 403) → `tokenAuth` (Bearer or `pg_token` cookie; `GET /?t=<token>` sets the
  cookie and redirects to `/`) → routes → static SPA.
- Error body is always `ApiError {error, code?, details?}`. zod body errors → 400 `code:"bad_request"`;
  `GraphNotFoundError` → 404; `GraphLoadError` → 422 `invalid_graph`; `EngineError` as in §6.

| Method & path | Request | Response |
|---|---|---|
| GET `/api/repo` | — | `RepoInfoResponse` |
| GET `/api/settings` · PUT `/api/settings` | `UpdateAppSettingsRequest` | `AppSettings` |
| GET `/api/graphs` | — | `ListGraphsResponse` |
| GET `/api/graphs/:id` | — | `GetGraphResponse` (`modifiedOutside` = file hash ≠ store known hash) |
| PUT `/api/graphs/:id` | `SaveGraphRequest` (Graph; `id` must match) | `SaveGraphResponse`; sets known hash; 409 while a run is active |
| DELETE `/api/graphs/:id` | — | `OkResponse`; 409 while a run is active |
| POST `/api/graphs/:id/validate` | `ValidateGraphRequest` (optional unsaved graph) | `ValidationResult` |
| POST `/api/graphs/:id/runs` | `{}` | `RunDetail` |
| GET `/api/runs?graph=&limit=` | `ListRunsQuery` | `ListRunsResponse` |
| GET `/api/runs/:id` | — | `RunDetail` |
| POST `/api/runs/:id/cancel` · `/cleanup` | — | `OkResponse` |
| GET `/api/pending` | — | `PendingResponse` (waiting_approval node runs) |
| POST `/api/node-runs/:id/done` · `/retry` · `/skip` | — | `NodeRunResponse` |
| POST `/api/node-runs/:id/fail` | `FailNodeRequest` | `NodeRunResponse` |
| POST `/api/node-runs/:id/hold` | `HoldNodeRequest` | `NodeRunResponse` |
| GET `/api/node-runs/:id/approval` | — | `ApprovalInfoResponse` |
| POST `/api/node-runs/:id/approval` | `ApprovalRequest` | `NodeRunResponse` |
| GET `/api/node-runs/:id/diff` | — | `DiffResponse` |
| POST `/api/node-runs/:id/reopen` | — | `ReopenResponse` |
| GET `/api/commands` | — | `ListCommandsResponse` |
| POST `/hooks/:nodeRunId/:event` | raw hook JSON | 204 (always fast; never blocks Claude) |

**WebSocket `/ws`** (`shared/ws.ts`): upgrade checks Host/Origin + `isAuthorized` (cookie or `?t=`). Server
sends `hello` on connect. `run:update` / `graphs:changed` → all clients; `node:update` / `lane:update` → clients
subscribed to the run; `pty:*` → clients attached to that pty. `pty:attach` → `pty:attached {live, cols, rows}`,
then replay as `pty:data` chunks (≤64 KiB each), then live data. `pty:input` → `PtyManager.userInput` (live
PTYs only; else `pty:error`). Most recent attach/resize drives PTY size.

**Implementation notes (server-http, minimal extensions):**
- `localhostOnly()` takes no argument: the Host (and Origin, if present) **hostname** must be `127.0.0.1`,
  `localhost` or `[::1]`; the port is not checked, because the vite dev proxy forwards its own Host
  (`127.0.0.1:5173`). DNS rebinding is still blocked (an attacker's Host is their domain). Shared with the WS
  upgrade as `isLocalRequest(host, origin)` in `http/auth.ts`.
- Cookie name is `TOKEN_COOKIE` (`pg_token`). `isAuthorized` also accepts `Authorization: Bearer`.
- `AppContext.env` (new): the server's base env (commands discovery, `PG_WEB_DIST`). `resolvePtyLogPath(store,
  paths, ptyId)` in `app/context.ts` maps node PTYs, `setup-`/`shell-<nodeRunId>` and (by scanning run dirs)
  `reopen-*` PTYs to their logs after a restart.
- `http/errors.ts` (new): `HttpError`, `toApiError`, `readBody(c, schema)` (empty body = `{}`), `readJson`.
  Extra codes: `unauthorized` 401, `forbidden_host` 403, `id_mismatch` 400 (PUT graph), `internal` 500.
- `AppSettingsStore.update` applies only keys present in the patch (`UpdateAppSettingsRequestSchema` is
  `.partial()` of a schema with defaults, so parsing `{}` yields `{notifications: true}`); PUT /api/settings
  validates the raw body and passes it on unparsed.
- `GET /api/graphs/:id`: `modifiedOutside` is true also when no hash is known yet (never run/saved by the app).
- Hooks: unknown event → 404; everything else (unknown node run, bad payload/JSON) → 204.
- Static: unknown paths without an extension → index.html; missing files with an extension → 404;
  `/assets/*` cached immutable.
- WS: replay chunks ≤ 64 KiB; a client whose `bufferedAmount` exceeds 16 MiB is terminated (it reconnects and
  re-attaches with a fresh replay); 30 s ping heartbeat; max client frame 1 MiB.
- `checkPrereqs`: only a missing git is an error; missing claude/gh and no desktop notifier are warnings
  (DESIGN §4.2 "only warns"). The CLI checks prerequisites before `resolveRepoRoot`.
- `pg-hook` needs no copy into `dist/`: `PG_HOOK_SOURCE` resolves to `packages/server/assets/pg-hook` from
  both `src/` and `dist/`.

## 9. Web (`packages/web/src`)

```
main.tsx, App.tsx, index.css     shell (Tailwind v4 via @tailwindcss/vite; status colour tokens in @theme)
api/token.ts                     getDevToken() — ?t= kept in sessionStorage for dev (vite proxy to :4777)
api/rest.ts                      `api` typed REST client, ApiRequestError
api/ws.ts                        WsClient (reconnect, re-subscribe, pty attach with decoded bytes), wsClient singleton
store/editor-store.ts            EditorState (zustand): graph, hash, dirty, validation (validateGraph from shared, phase = RepoInfoResponse.phase), selection; autosave 500 ms
store/run-store.ts               RunState: runs list, selected run detail, currentByNode, lanes; merges WS updates
store/ui-store.ts                UiState: terminal tabs, drawer height, dialogs
components/header/               graph selector, Run/Cancel, pending approvals counter, run selector, run cost total
components/palette/              draggable node types (prompt, command, shell, commit, pr, approval, merge; condition when phase 2)
components/canvas/               React Flow canvas: snap grid, minimap, edge creation (error/true/false ports in phase 2), read-only in run mode
components/nodes/                node cards: status colour (§8.2), elapsed time, activity, lane badge, tokens/cost, validation outline + tooltip
components/inspector/            node config forms; run mode: NodeRun details (output, session, branch, timings, error, usage) + controls
components/terminal/             drawer with tabs; xterm + fit + web-links; live or replayed; "Reopen session"
components/history/              run history list (status, duration, cost), cleanup action
components/approval/             approval dialog: message, diff2html diff, predecessor outputs, PR title/body edit, approve/reject
components/settings/             app settings (notifications toggle) + graph settings form
```

The UI is English. Only `errors` disable Run; `warnings` are shown but non-blocking. The store files currently
hold only state interfaces; builders add the zustand stores there.

**Implementation notes (web, minimal extensions):**
- Stores extend the contract interfaces: `EditorStore extends EditorState` adds `phase`, `graphId` (also set when
  the file failed to load), `loading`, `loadError`, `saveError`, `activeRunId` (graph read-only while set),
  `externalChange` (file changed on disk while dirty), multi-selection `selectedNodeIds/selectedEdgeIds`
  (`selectedNodeId/EdgeId` only when exactly one element is selected) and actions; `RunStore extends RunState`
  adds `graphId`, `detailError`, `selectedNodeId` (run-canvas inspection); `UiStore extends UiState` adds
  `tabMeta`, `drawerOpen`, `leftPanel` (palette | history), `toasts`. New `store/app-store.ts` (repo, app
  settings, graph list, commands, pending approvals, WS connection) and `store/app-actions.ts` (cross-store
  workflows + WS → store routing). Test seams: `setEditorPersistence`, `setRunStoreDeps`, `new WsClient(urlFn)`.
- `WsClient` adds `onConnection(listener)` and `resizePty(ptyId, cols, rows)` (remembers the size for re-attach).
  On every `pty:attached` (first attach and re-attach after reconnect) the terminal is reset before the replay.
- `api/token.ts` adds `devToken()` (memoised `getDevToken()`; the `t` param is stripped from the URL).
- Vite proxy target port: `PG_DEV_PORT` (then `PG_PORT`), default 4777; it rewrites `Origin` to the target.
- The palette always lists every node type; `condition` carries a "phase 2" badge while `phase` is 1 (the
  validator rejects it there).
- Replayed (finished) terminals drop "leave alternate screen" sequences (`lib/terminal-replay.ts`), so a Claude
  Code session replays its last screen instead of the empty main screen. The canvas re-fits when the drawer
  opens/closes.

## 10. fake-claude (`packages/server/test/fixtures/fake-claude`)

Executable Node script; use with `PG_CLAUDE_BIN=<path>` (see `test/helpers.ts: FAKE_CLAUDE, fakeClaudeEnv`).

- Flags: positional message, `--session-id`, `--resume|-r`, `--settings <path|json>`, `--permission-mode`,
  `--model` (aliases), `--effort`, `--name`, `--allowedTools …`, `-p/--print`, `--output-format`,
  `--json-schema`, `--version`. Unknown flags are ignored.
- Interactive: prints a fake TUI, runs `SessionStart {session_id, transcript_path, cwd, hook_event_name,
  source: startup|resume, model}`, processes the initial message as a turn, then reads stdin lines (each line =
  a new turn; `/exit` → "Goodbye!" exit 0; stdin EOF → exit 0). Each turn appends a user line and an assistant
  line (`message.model`, `message.usage` = 12 in / 34 out / 1000 cache-create / 2000 cache-read, `message.id`)
  to `$CLAUDE_CONFIG_DIR/projects/<cwd with non-alnum → "-">/<session>.jsonl` (default config dir:
  `$TMPDIR/fake-claude-config`), then runs `Stop {last_assistant_message, stop_hook_active:false,
  permission_mode}`. Hooks run like Claude Code: `sh -c <command>` with the JSON payload on stdin, sequentially,
  `matcher` honoured for PreToolUse.
- Markers (in the message, or globally via `FAKE_CLAUDE_MODE=normal|fail|ask|crash|idle|hang` or a raw marker):
  `[[fail]]` exit 1 · `[[crash]]` exit 0 without Stop · `[[hang]]` never finishes the turn · `[[ask]]`/`[[ask:msg]]`
  Notification `permission_prompt` then waits for one input line · `[[idle]]` Notification `idle_prompt` after Stop ·
  `[[write:path:content]]` PreToolUse Write + writes the file · `[[bash:cmd]]` PreToolUse Bash + runs it ·
  `[[tool:Name]]` PreToolUse only · `[[sleep:ms]]` · `[[reply:text]]` exact reply · `[[marker:TOKEN]]` reply ends
  with `\nTOKEN` · `[[recall]]` reply = previous assistant text of the session (resume tests) · `[[exit]]` exit 0
  after Stop. Default reply: `Done: <message without markers, 60 chars>`; slash command → `Ran /cmd`.
- Trust dialog: with `FAKE_CLAUDE_CHECK_TRUST=1` it shows the dialog unless
  `$CLAUDE_CONFIG_DIR/.claude.json` has `projects[cwd].hasTrustDialogAccepted === true`; input `1`/`y…`
  accepts, anything else exits 1.
- Headless `-p`: prompt = positional + stdin. `--output-format json` prints the real envelope shape
  `{type:"result", subtype, is_error, result, session_id, total_cost_usd, usage, modelUsage, num_turns,
  duration_ms, structured_output?}`. With `--json-schema`, `structured_output` is synthesised from the schema
  (strings `"fake <prop>"`, booleans `true` — `false` if the prompt contains `[[judge:false]]`, numbers 0) or taken
  from `FAKE_CLAUDE_STRUCTURED` (JSON); `result` is its JSON string. `[[fail]]` → `is_error:true`, exit 1.
- `FAKE_CLAUDE_DELAY_MS` (default 50) per-turn latency; `FAKE_CLAUDE_LOG=<file>` appends one JSON line per
  invocation `{argv, cwd, pid, env: PG_*/CLAUDE*/HERMETIC/TERM}` (assert stripping and args).

Real envelope (Claude Code 2.1.314) for reference: `structured_output` holds the parsed object, `result` the
same JSON as a string, `stop_reason`, `total_cost_usd`, `usage` (+ `cache_creation.ephemeral_1h_input_tokens`),
`modelUsage[model].costUSD`, `is_error`, `subtype:"success"`.

## 11. Testing

- `pnpm test` runs everything with vitest (forks pool, 20 s timeout). Put server tests in `packages/server/test/`.
  Each package also has `test` (`vitest run --root ../.. packages/<name>/`), so `pnpm -r test` works.
- End-to-end tests: `packages/server/test/e2e/` (`harness.ts`: temp repo + PG_HOME + fake claude, in-process
  `startServer`, REST + WS client). The crash-recovery case runs the CLI in a child process (`tsx
  --conditions=source`) and SIGKILLs it.
- `test/helpers.ts`: `tempDir`, `createTempRepo` (branch `main`, one commit), `fakeClaudeEnv(root)` (`PG_HOME`,
  `CLAUDE_CONFIG_DIR`, `PG_CLAUDE_BIN`), `realClaudeEnv(root)`, `waitFor`.
- Pass env explicitly (`createAppContext({env})`, `childEnv(extra, base)`) instead of mutating `process.env`.
- Real claude tests are opt-in (`PG_REAL_CLAUDE=1`), use `realClaudeEnv` (a **copy** of `~/.claude.json` with
  `hasCompletedOnboarding: true`, `theme: "dark"`), strip env via `childEnv`, and keep prompts tiny
  ("Reply with exactly PONG"). Never modify `/root/.claude.json` / `~/.claude.json`.
- Use port 0 for servers in tests (`startServer({port: 0})`).
