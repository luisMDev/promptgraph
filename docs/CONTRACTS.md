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
| `run.ts` | `TokenUsage`, `NodeRunOutput`, `WaitingReason`, `NodeRun`, `Lane`, `RunSummary`, `Run` (= summary + `graphSnapshot`), `RunDetail` (+ Phase-2 `loops?: LoopState[]`), `LoopState`, `RunEvent` |
| `pricing.ts` | `PRICE_TABLE`, `MODEL_ALIASES`, `priceFor`, `RawUsage`, `costFromUsage`, `emptyUsage`, `accumulateUsage`, `sumUsage`, `formatCostUsd` |
| `hooks.ts` | `HookEvent` (`session-start`/`activity`/`notification`/`stop`), `CLAUDE_HOOK_FOR_EVENT`, payload schemas, `HookPayloadMap`, `describeToolActivity` |
| `headless.ts` | `HeadlessResultSchema` (real `claude -p --output-format json` envelope), `GENERATED_MESSAGE_JSON_SCHEMA`, `JUDGE_JSON_SCHEMA` |
| `condition.ts` | `regexError(pattern, flags)` → message or null (validator + ConditionRunner) |
| `api.ts` | REST request/response schemas (§7 below), `AppSettingsSchema`, `API` path builders, `TOKEN_COOKIE` |
| `ws.ts` | `ServerMessageSchema`, `ClientMessageSchema` (discriminated unions), `encodeBase64`/`decodeBase64` |
| `topology.ts` | `buildTopology`, `findRoots`, `topologicalOrder`, `findCycle`, `ancestors`, `descendants`, `branchKey`, `edgesMutuallyExclusive`, `loopBody`, `computeLanePlan` → `LanePlan {lanes: PlannedLane[], laneOf, mergeSources, edgeLane}` |
| `validation/` | `validateGraph(graph, {phase})` → `ValidationResult {errors, warnings}` of `ValidationIssue {code, message, nodeId?, edgeId?}` |

Semantics fixed here (do not re-implement elsewhere):

- **Edge matching** `edgeMatches(edge, outcome)`: `when` defaults to `failure` for `sourcePort:"error"`, else `success`;
  `true`/`false` ports match `outcome.port`; `always` matches every outcome. Phase 1 graphs only contain `out` +
  success edges.
- **Lane plan** `computeLanePlan` (§9.2): root lanes are created first in canvas order (`main`, `l2`, `l3`…),
  forks get the next ids in topological order. Branch-key groups (`out`/`true`/`false`/`error`) are mutually
  exclusive and never fork — except that a node with an `always` edge has a single group (that edge fires with
  the success and the failure side). `mergeSources.get(mergeNodeId)` = lanes to merge, in canvas order of the inputs
  (§18 Q4: sequential pairwise, no octopus). `edgeLane.get(edgeId)` = lane an edge grants its target; a
  fan-out edge straight into a merge grants a fork lane whose `firstNodeId` is the merge itself.
- **Validation phase**: the server passes `SUPPORTED_PHASE` (`config/version.ts`, **2** since M5/M6). Phase 1 rejects
  condition nodes, non-success edges and loops (`phase2_unsupported`) and every non-merge join (`invalid_join`).
  Phase 2 allows joins whose inputs are pairwise `edgesMutuallyExclusive` **and** granted the same lane
  (`edgeLane`), see engine-flow notes for the exclusivity proof and the loop rules.
- **Warnings** (never block Run): `uncommitted_before_pr`, `uncommitted_before_merge` (§18 Q1 — the engine
  checkpoints automatically), `empty_label`, `condition_input` (no input; or an exit-code condition fed by a
  shell through a `success` edge — a failing shell never reaches it, use `always`), `unconditional_loop`,
  `on_error_ignored`.
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
- Env (`config/child-env.ts`): `claudeBin()` = `PG_CLAUDE_BIN` or `claude`; `ghBin()` = `PG_GH_BIN` or `gh`. **Every** child process gets
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
| `config/version.ts` ✅ | `VERSION`, `SUPPORTED_PHASE` (= 2) | done (M5 bumped the phase) |
| `config/app-settings.ts` | `AppSettingsStore {get, update}` | M2 |
| `events/bus.ts` ✅ | `EventBus`, `BusEvents`, `AttentionKind` | done |
| `util/ids.ts`, `util/text.ts` ✅ | see §3 | done |
| `store/schema.ts` ✅ | `MIGRATIONS` (user_version based; #2 adds `runs.loops`) | done (M6) |
| `store/store.ts` | `openDatabase`, `Store` DAO, `NewRun`, `RunPatch`, `NewLane`, `LanePatch`, `NewNodeRun`, `NodeRunPatch` | M1 |
| `graphs/graph-store.ts` | `GraphStore {ensureDir, list, get, save, delete, watch}`, `hashContent`, `serializeGraph`, `GraphNotFoundError`, `GraphLoadError` | M1 |
| `git/exec.ts` ✅ | `git`, `gitOk`, `GitError` | M1 |
| `git/repo.ts` ✅ | `resolveRepoRoot`, `currentBranch`, `listBranches`, `revParse`, `isDirty` | M1 |
| `git/merge-state.ts` ✅ | `gitPath`, `hasMergeHead`, `hasPendingSquash`, `unmergedFiles`, `mergeInProgress` | M3 fixes |
| `pty/ring-buffer.ts` | `RingBuffer`, `PTY_RING_BYTES` (2 MB) | M1 |
| `pty/pty-manager.ts` | `PtyManager`, `PtyHandle`, `SpawnPtyOptions`, `PtyAttachResult`, `logSizePath` | M1 |
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
| `runners/git/merge-runner.ts` | `MergeRunner`, `MergeRunnerDeps`, `conflictPrompt`, `mergeMessage` | M3 (done) |
| `runners/git/pr-runner.ts` | `PrRunner`, `PrRunnerDeps` | M4 (done) |
| `runners/approval-runner.ts` | `ApprovalRunner`, `ApprovalGate`, `Interruption`, `approvalOutput`, `rejectionError` | M4 (done) |
| `runners/condition-runner.ts` ✅ | `ConditionRunner` (+ `evaluatedPredecessor`, `evaluateExitCode`, `evaluateRegex`, `buildJudgePrompt`, `parseJudgeVerdict`, `laneDiffStat`) | M5 |
| `runners/registry.ts` | `createRunnerRegistry` | M1 (+ each milestone adds its runner) |
| `workspace/lane-manager.ts` | `LaneManager`, `RepoRef`, `MergeAttempt` | M1 (single lane) / M3 (forks, merge, cleanup) |
| `workspace/setup.ts` | `runWorkspaceSetup` | M3 |
| `engine/state.ts` ✅ | `NODE_TRANSITIONS`, `canTransition`, `assertTransition`, `RUN_TRANSITIONS` | done |
| `engine/activation.ts` ✅ | `ActivationTracker`, `ActivationDelta`, `LoopIteration` | M1 (skips/dead paths M5, loops M6) |
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
| `cli/prereqs.ts` | `checkPrereqs` (git, `claudeBin`, `ghBin` `--version`) | M1 |
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

**Implementation notes (engine-lanes, M3):**
- Fork lanes are created when their fork-after node resolves, for every lane granted (`LanePlan.edgeLane`) by an
  outgoing edge that delivered an activation (`ActivationTracker.isActivated(edgeId)`) — also when the target is a
  merge that is not ready yet, so the fork captures the parent at that point. Dead (skipped) branches get no lane.
- Before a `merge` runner starts, the engine checkpoints the merge's own lane and each source lane (labelled after
  the input node in that lane) and passes the sources as `ctx.mergeSources` (Lane objects, canvas order of the
  inputs, only lanes reached through activated edges; a source lane missing after a restart is created then).
  `LaneManager.merge` still checkpoints both sides (no-op by then).
- `RunnerContext` adds `mergeSources: Lane[]`, `baseBranch` (pr: non-empty `config.base`, else
  `settings.baseBranch`; others: `settings.baseBranch`) and `claudeSlot()`: waits for a slot under
  `maxParallelClaude` (`Scheduler.acquireClaudeSlot(nodeRunId)`; held until the node is released; waiters go
  before queued Claude items) and rejects with "Cancelled" when the node's signal aborts. MergeRunner must await it
  before spawning a Claude conflict resolver.

**Implementation notes (engine-flow, M5/M6):**
- **Outcomes.** `succeeded` → `{kind:"success", port: output.port}` (condition runners set `port`), `failed` →
  `{kind:"failure"}`. Every outgoing forward edge delivers an activation (`edgeMatches`) or a skip; a node whose
  inputs are all resolved with ≥1 activation is ready (join "all"); only skips → `skipped` (dead path) and it
  propagates skips (§15.3). A failure is **handled** when a forward edge matches it (`when` failure/always, error
  port) or a loop edge loops back on it; handled failures advance the flow and `onError` does not apply; others
  follow `onError` (pause / fail-run). The failed node run keeps `error` + runner `output` (shell `exitCode`,
  `stdoutTail`), so `ctx.predecessors` of the failure branch carry it into the context block (§15.1).
- **Context** (`ctx.predecessors`): direct predecessors whose edge delivered an activation (all of them when none
  did, e.g. a user-skipped input), canvas order, current node runs; dead branches of an exclusive join are left out.
  A loop target in a later iteration also gets, last, the loop-source run that looped back (from the
  `loop.iteration` event). `getApprovalInfo` still lists every direct predecessor.
- **Run end**: `blockingNodeRuns` = current `interrupted`/`cancelled`, or `failed` that the tracker has not resolved
  (unhandled). Nothing blocking and everything `succeeded`/`skipped`/handled-`failed` → `succeeded`.
- **Provably exclusive joins** (`edgesMutuallyExclusive`, validator): edges `a`, `b` are exclusive iff some node S
  and a key pair of S that never fire together — `true`/`false`, `out`(success)/`error`, `true`/`error`,
  `false`/`error` — has each edge *dominated* by one side: the edge is that side's edge of S, or its source can only
  be activated through that side (every forward input of it is that side's edge of S or comes from a node
  dominated by it; computed in topological order). `always` edges dominate nothing. S runs once per pass and fires
  one side, so at most one of the two edges activates. "Reached only through a side" is not enough (a second,
  unrelated input could activate the node). Covers if/else re-joins and "step + its failure path" re-joins. Both
  branches of a condition keep the lane (branch-key groups), and the validator additionally requires every input
  of a plain join to be granted the same lane; otherwise a merge is required.
- **Loops (§15.4)**. `maxIterations` = how many times the loop edge may **loop back** (the body runs at most
  `maxIterations + 1` times); `LoopState.iteration` = loop-backs so far (0-based, = the body nodes' `NodeRun.
  iteration` for a single loop; the UI badge reads `iteration/maxIterations`). Body = `loopBody(topo, edge)` (forward
  paths target → source, both included; a self-loop edge repeats one node, e.g. `error` port loop = retry).
  Validation (`invalid_loop`): target must be an ancestor of the source (or the source), removing loop edges leaves
  a DAG (`cycle`), bodies are disjoint or strictly nested (overlap / identical bodies → error), a body has no merge
  node and starts no parallel branch (every body node and every edge leaving a body node keeps the body's lane).
  Warning `unconditional_loop`: an `always` loop edge, or a success loop from an `out` port whose body has no
  condition and no failure/always edge, with onExhausted `fail` (it can only end in a failure).
- **Loop runtime** (`ActivationTracker`, pure): while a loop may still repeat, deliveries from its body to nodes
  outside it are **held** (innermost open loop); when the source resolves, its loop edges are settled innermost
  first: matching edge with `iteration < max` → loop back (`delta.loops`), else the loop closes (a matching edge at
  the limit sets `exhausted`) and the held deliveries go out. So a branch skipped in an early pass ("tests pass →
  commit") is not dead, nodes after a loop run once with its last iteration, and a dead-path-skipped source closes
  the loop. Loop back: deliveries between body nodes are forgotten, deliveries into the body from outside are kept,
  nested loops inside restart at iteration 0 / not exhausted, the target is released again. A delta is applied
  as: skipped → loops → ready (ready is filtered to nodes still released after resets).
- **Engine on loop back** (`startIteration`, one transaction): every body node gets a new `pending` NodeRun with
  `iteration = previous + 1`, `attempt 0`, same lane (history kept); an unfinished body node run (only when the
  user skipped the source early) is skipped (pending/ready) or cancelled (live); `runs.loops` (= `tracker.
  loopStates()`) is persisted; event `loop.iteration {edgeId, iteration, sourceNodeRunId, targetIteration, body}`;
  `node:update` for the new node runs and `run:update`. Clients refetch `RunDetail.loops` (the web does on
  node/run updates).
- **Exhaustion**: `onExhausted:"fail"` — before persisting the source's success, `exhaustedFailLoop` turns it into
  `failed` "Loop back to "<target>" reached its limit of N iterations" (output kept, event `loop.exhausted`), routed
  by the source's failure edges or else `onError`. Retry re-runs the source (same iteration, attempt+1); **skip**
  (user-skip = success) continues past the loop (the edge is exhausted, so it delivers a skip like `continue`).
  `"continue"` — the loop edge delivers a skip, the loop closes and the flow continues. A failure loop edge at its
  limit does not handle the failure.
- **Store**: migration #2 `runs.loops` (JSON `LoopState[]`, NULL without loop edges), `RunPatch.loops`,
  `Store.getLoopStates(runId)`. `RunDetail.loops` lists every loop edge (persisted state, else iteration 0).
- **Crash recovery / restore**: `ActivationTracker.restore(graph, finished, loopStates)` replays the current node
  runs (latest iteration, latest attempt) in topological order with the persisted counters, so held deliveries
  and closed loops are recomputed. A source that finished right before a crash (its new iteration never
  persisted) loops back during the replay: `takeRestoredLoops()` → the engine creates that iteration
  (`ensureLive`) and `resumeRun`/retry/skip continue. Failed current node runs count as handled when a forward
  failure edge exists or a loop edge would loop back with the persisted counters.
- **RunnerContext** (optional, additive): `previousIteration` (this node's latest run of the previous iteration)
  and `inLoopBody`. ClaudeRunner, `context:"resume"`: `previousIteration.sessionId` → resume the node's own session
  (prompt only, §15.4); else the predecessor rule; with no session to resume inside a loop body (first pass after
  a condition) → a new session with the fresh context block. The validator skips the resume predecessor rule for
  loop-body nodes. `fresh` gets the current iteration's predecessors (plus the loop source for the target).
- Approval/PR dialog predecessors (`getApprovalInfo`) leave out skipped inputs when another input ran (dead
  branch of an exclusive join), like the runner context.
- Tests: `test/activation.test.ts`, `test/engine-flow.test.ts` (fakes shared with `engine.test.ts` in
  `test/support/engine-fakes.ts`; `setup(runners, {phase: 2})`), `packages/shared/test/flow-validate.test.ts`, and
  `test/e2e/flow.e2e.test.ts` (real server + shell + condition runners, fake claude) covering the §15.5 patterns:
  test-fix loop (fails twice → 2 extra iterations → commit; exhausted `fail` pauses; exhausted `continue` goes on),
  review loop with a scripted judge (`FAKE_CLAUDE_JUDGE_SCRIPT`), failure routing (never pauses), if/else re-join
  with transitive dead-path skips, retry inside an iteration, context `resume` across iterations, and crash
  recovery mid-loop (child process SIGKILLed while the iteration-1 fix hangs). Opt-in real:
  `PG_REAL_CLAUDE=1 pnpm vitest run packages/server/test/e2e/flow.real.test.ts` (haiku: `test -f ok.txt` →
  exit-code condition → false: "Create an empty file named ok.txt" ⟲ (max 3); passes on the second pass,
  iteration 1, and commits `ok.txt`).

## 7. Runners (`runners/`)

Contract in `runners/types.ts`. A runner never writes final statuses; it returns a `RunnerResult`. While
running it may `ctx.update({status: "running" | "idle" | "waiting_input" | "waiting_approval", …})`.

**ClaudeRunner** (prompt, command; also used by MergeRunner for conflicts):
- Options: `node.config.X ?? settings.defaults.X` for model, effort, permissionMode, allowedTools, completion.
- `hooks.json` once per run at `hooksSettingsPath` with commands `'<binDir>/pg-hook' <event>` (§7.2).
- Spawn: `claudeBin()` with `buildClaudeArgs(spec)`, cwd = lane worktree, 120×40, env
  `childEnv({PG_PORT, PG_HOOK_HEADER_FILE, PG_NODE_RUN_ID})` (header file = `Authorization: Bearer hookToken(token, nodeRunId)`, 0600), PTY id = nodeRun.id, `logPath = ptyLogPath(...)`.
  `spec.name = "pg:<graph-id>/<node-label>"`.
- Trust (SPIKE A5): `settings.autoTrustWorktrees` → `preTrustDirectory(worktreePath, env)` before spawn.
  Otherwise watch stripped PTY output for `TRUST_DIALOG_PATTERN` → `waiting_input {kind:"trust_dialog"}`.
- Hook handling via `HookRouter.register(nodeRunId, …)`:
  `session-start` → `{sessionId, transcriptPath}`, status running ·
  `activity` → `activity = describeToolActivity(p)`, waiting_input/idle → running ·
  `notification` → `waiting_input {kind:"notification", notificationType, message}` ·
  `stop` → text = `last_assistant_message` ?? `waitForLastAssistantText(transcript)`; `output = {text, usage:
  usageFromTranscript(transcript, baseline)}` where `baseline` = assistant message ids already in a resumed
  transcript (`--resume` appends to the same file; that usage belongs to the predecessor / previous attempt);
  `CompletionController.onStop(text)`.
- Completion (`CompletionController`, §7.4): auto grace (user input cancels), manual → idle, marker → token
  check, hold forces manual for the current turn (the next turn releases it: `holdReleased` → `hold:false`).
  `done()` from idle → success. Command nodes in marker mode get the marker instruction after the command.
- Ending (success/done/fail/cancel) → `"/exit\r"` only when Claude sits at its input prompt (a Stop and no
  activity/input/dialog since); otherwise SIGTERM directly, since Enter in a permission or trust dialog
  accepts its default "Yes". Then wait 3s, kill. PTY exit before success (and not cancelled) → failed.
- `reopen()` (M2): `claude --resume <sessionId>` in a new PTY `reopen-<id>` (not part of the run); while it is
  live the same ptyId is returned. `closeReopened(ptyId)` (DELETE `/api/ptys/:ptyId`) SIGTERMs it.

**ShellRunner**: `sh -c <run>` in a PTY (id = nodeRun.id); output `{exitCode, stdoutTail, timedOut?}`.

**CommitRunner / PrRunner / MergeRunner / ApprovalRunner / ConditionRunner**: see each file's doc comment.
Generated messages use `runHeadless` with `GENERATED_MESSAGE_JSON_SCHEMA` and read `structured_output`.

**Implementation notes (server-runners, minimal extensions):**
- Optional `env` (base env, default `process.env`) on `HeadlessOptions`, `GenerateMessageInput`, `ShellRunnerDeps`,
  `CommitRunnerDeps`, `RunnerRegistryDeps`; `detectNotifyPlatform(env?)`. `CommitRunner` needs only
  `lanes.withLaneLock`. `NotifierDeps` has test seams `detect?`/`send?`.
- `runners/git/checkpoint.ts` (new): `CHECKPOINT_PREFIX`, `checkpointMessage`, `isCheckpointMessage`,
  `checkpointIfDirty(cwd, label)` (what `LaneManager.checkpoint` should call under its lane lock) and
  `squashTarget(cwd, baseRef, keep?)`. `squashCheckpoints` soft-resets over trailing checkpoints but **never below
  `lane.baseRef`** (history shared with a parent lane stays intact).
- `CompletionController.onActivity()` (PreToolUse after idle/grace → running). Hold is remembered even when set
  before the controller exists and is seeded from `nodeRun.hold`.
- `resolveClaudeOptions(node, defaults)` and `describePredecessor(p)` are exported (merge/judge reuse).
- Notification `idle_prompt` is ignored after a Stop (the completion policy already decided); other
  notifications → `waiting_input`. `context:"resume"` with no same-lane Claude predecessor session → failed.
- Graceful stop (at the input prompt only) writes `/exit`, then `\r` 100 ms later (verified with real Claude
  Code), waits 3 s, SIGTERM, SIGKILL.
- Pre-trust also trusts the directory's realpath and writes through a symlinked config; unparsable config → throws
  (node fails) instead of overwriting.
- `PtyManager`: spawning an id that is still live throws; `get()` also returns exited handles; exit `code` is null
  when killed by a signal. Reopen PTYs log to `ptyLogPath(paths, run.id, "reopen-<id>")` — the composition root's
  `resolveLogPath` must map those after a restart.
- Commit messages are generated from `ctx.laneOutputs`: every ancestor back to (excluding) the previous
  commit node that ran in this iteration, walking through merge nodes into all their inputs (merge nodes left
  out), canvas order (§6.1).
- Real-claude test: `PG_REAL_CLAUDE=1 pnpm vitest run packages/server/test/claude-runner.real.test.ts`.

**Implementation notes (integration M1+M2):**
- `git/exec.ts`, `git/repo.ts`, `workspace/lane-manager.ts` and `workspace/setup.ts` are implemented (incl. M3's
  `merge`; the unused `concludeMerge`/`abortMerge` were removed in the M3/M4 review fixes). `git()` only opens stdin when `input` is given (no EPIPE on early exit).
- `LaneManager.diff` stages HEAD + all worktree changes into a throwaway index (`GIT_INDEX_FILE`) and diffs it
  against the merge-base, so untracked files show up without touching the lane's index.
- `LaneManager.cleanup` (§9.6) removes worktrees and deletes unpushed branches **only when they carry no commits
  of their own** (or the lane was merged). A run without a `pr` node keeps its branch (e.g. the commit node's work).
- `Engine.resumeRun` (POST `/api/runs/:id/resume`) continues a paused run that has no failed/interrupted/
  cancelled node (e.g. stopped while fork lanes were created); `finalize` waits (bounded) for in-flight lane
  creations before cleanup. Workspace setup is retried until it succeeds (also after a restart: lanes with no
  node run whose `laneSetup` is `succeeded`). User skips set `output.skippedByUser`.
- Only node types with a runner pass validation (`ValidateOptions.supportedNodeTypes`,
  `RepoInfoResponse.supportedNodeTypes`, error `unsupported_node_type`).
- `PtyManager.userInput` ignores terminal-generated reports (focus, mouse, query replies; `pty/terminal-reports.ts`)
  for the user-input signal, and releases the ring buffer once a PTY has exited (attach reads the log).
- `Engine.shutdown` also waits (bounded by `stopTimeoutMs`) for in-flight node chains (finish → advance →
  finalize/cleanup) so nothing writes to the store after the DB is closed.

**Implementation notes (condition-runner, M5):**
- `ConditionRunner` (`{env?}`, registered as `condition`) evaluates the first direct predecessor (canvas order)
  whose current node run succeeded or failed (exclusive joins); none → failed. Output
  `{result, port: "true"|"false", text: reason}` plus the evaluated predecessor's `exitCode`/`timedOut`/`stdoutTail`
  when present (so a fix node behind `false` sees the failing output), judge `usage`. The engine routes on
  `output.port` (existing outcome mechanism; `RunnerResult` unchanged). Evaluation errors → failed.
  - exitCode: `exitCode === equals`; predecessor without `exitCode` (not a shell) → failed "Exit-code condition:
    predecessor … has no exit code"; `null` (timeout/signal) → false. Validator: `invalid_config` "An exit-code
    condition needs a shell predecessor." (phase 2).
  - regex: fresh `RegExp(pattern, flags)` on `output.text ?? output.stdoutTail ?? error ?? ""`; invalid → failed
    (validator uses the same `regexError`).
  - judge: `runHeadless` with `JUDGE_JSON_SCHEMA`, model `evaluator.model ?? settings.defaults.model`, timeout
    `evaluator.timeoutSec ?? 120` s (both new optional fields of the judge evaluator), cwd = lane; prompt =
    instructions + question + `describePredecessor` (8k) + `laneDiffStat` (`git diff --stat --summary` of the
    worktree vs merge-base with `ctx.baseBranch`, + untracked files). Verdict = `structured_output`, else JSON in
    `result` (bare/fenced/embedded; `pass` may be "yes"/"no"); none → failed "Judge returned no verdict: …".
  - Event `condition:evaluated {kind, result, predecessor}`. Context block (`describePredecessor`): a node with
    `output.port` renders `Condition result: <port>` before its text.
- `NodeRunOutput.result?: boolean` (condition). Real test:
  `PG_REAL_CLAUDE=1 pnpm vitest run packages/server/test/condition-runner.real.test.ts` (haiku).

**Implementation notes (git-runners, M3/M4):**
- `ApprovalRunner` (`runners/approval-runner.ts`) also exports the gate helpers `ApprovalGate` (first `approve()` wins,
  null on abort), `Interruption` (fail reason + abort → failed/cancelled result), `approvalOutput`, `rejectionError`.
  approval: `waiting_approval` → approve → `{approved, comment?}`; reject → failed "Approval rejected[: comment]";
  `done()` approves without a comment.
- `PrRunner` (`{lanes: withLaneLock+markPushed, env?}`): proposal = fixed `config.title` + `config.body` (both set), else
  `generateMessage("pr")` from `git diff --stat --summary <ctx.baseBranch>...HEAD`, the lane's commit subjects (checkpoints
  excluded; `GenerateMessageInput.commits`) and `laneOutputs` + succeeded direct predecessors; a fixed title or body
  overrides its generated part. Stored as `output {title, body, usage?}` before the gate (the approval dialog reads it).
  Gate unless `requireApproval === false && settings.allowPrWithoutApproval`. Approve → edited title (non-empty)/body
  override; then `git push origin <approved sha>:refs/heads/<branch>` (see review fixes below) from the lane worktree (lane lock; `LaneManager.markPushed`; a relative
  local origin URL such as `../origin.git` is passed as `-c remote.origin.pushurl=<absolute, resolved against the main
  checkout>` unless a pushurl is configured), then
  `<ghBin> pr create --base <base> --head <branch> --title <t> --body-file - [--draft]` (body on stdin,
  `GH_PROMPT_DISABLED=1`); output `{prUrl, title, body, approved, comment?}`. A gh "already exists" error with a URL
  counts as created (retry). Push/gh errors → failed with stderr, keeping the proposal in the output.
- `MergeRunner` (`{lanes, ptys, claude: Runner, paths, env?}`) merges `ctx.mergeSources` in order via `LaneManager.merge`
  (message `Merge branch '<source>' into <target>`). Conflict → claude: `ctx.claudeSlot()`, then `claude.start` with a
  synthetic `prompt` node (merge node id/label, `conflictPrompt(files)`, context "clean", graph defaults) on the same
  ctx/lane (PTY id = nodeRun.id); Done/Fail/Hold/typing are forwarded. pause: `waiting_input {kind:"merge_conflict"}`
  + `$SHELL` PTY `shell-<nodeRunId>` (set as `ptyId`) until `done()`; closed with SIGHUP. Conclusion (lane lock):
  conflicted files with `<<<<<<<`/`>>>>>>>` lines are unresolved; others are staged (`git add -A -- files`); unmerged
  paths left are unresolved; then `git commit --no-edit` (MERGE_HEAD) or, for squash, a commit with the merge message
  (nothing if already committed). pause: unresolved → keeps waiting with a message naming the files; claude:
  unresolved → failed. Failure/fail()/cancel abort the merge (`reset --hard` to the pre-merge HEAD, see review
  fixes). Resolved sources → `LaneManager.markMerged`. Output `{sha, conflictedFiles, usage?}`
  (usage = sum of the resolver sessions).
- `LaneManager` adds `markMerged(lane)` and `markPushed(lane)` (persist + `lane:update`).
- Approval/diff/pending routes, `getApprovalInfo`/`getDiff` and the `attention` → `Notifier` path for
  `waiting_approval` were already in place; covered by `test/e2e/ship.e2e.test.ts`.
- Opt-in real test: `PG_REAL_CLAUDE=1 pnpm vitest run packages/server/test/pr-message.real.test.ts` (haiku).

**Implementation notes (integration M3+M4):**
- `squashTarget` treats as noise both checkpoints and merge commits whose merged-in side (`first..other` parent)
  holds only checkpoints and merges, so root → fan-out → merge → commit ends in **one** commit on the lane (the
  lane merges of checkpoint-only lanes are squashed too). A merged side with a real commit (e.g. a commit node in a
  fork lane) stops the squash there. Still never below `lane.baseRef`.
- Commit messages are generated from `git diff --cached --stat --summary` (the summary's create/delete lines tell the
  model which files are new).
- `Engine.finishNode` stamps `finishedAt` before `scheduler.release`, so a node started by the freed slot never has a
  `startedAt` earlier than the previous node's `finishedAt`.
- `ApprovalInfoResponse.predecessorOutputs[].text` falls back, for commit/merge predecessors, to
  `Commit <sha8>: <message>`, `Nothing to commit.` or `Merged at <sha8>[, resolved conflicts in <files>]`.
- `test/e2e/lanes.e2e.test.ts`: fan-out → merge → commit → approval → pr (worktrees/branches, checkpoints squashed,
  push to a bare origin, fake-gh argv, cleanup keeps the pushed branch and deletes the merged fork), merge conflicts
  (claude via `FAKE_CLAUDE_MODE=[[bash:…]]` that acts only while MERGE_HEAD exists; pause via the `shell-<id>` PTY +
  Done), `maxParallelClaude` 1 vs 3, approval reject in one lane, workspaceSetup failing only in a fork lane, pr reject.
  Opt-in `test/e2e/lanes.real.test.ts` (`PG_REAL_CLAUDE=1`, haiku): the same fan-out with real Claude, merge and a
  generated commit message.

**Implementation notes (M3/M4 review fixes):**
- Interrupted merges: `checkpointIfDirty` throws while the worktree is mid-merge (`mergeInProgress`: MERGE_HEAD,
  SQUASH_MSG or unmerged paths), so conflict markers are never committed as a checkpoint (e.g. a pr after a skipped
  merge fails instead). Before a merge node checkpoints its lane (`Engine.prepareMerge`), `LaneManager.
  resetInterruptedMerge(lane)` hard-resets a lane left mid-merge (crash while resolving, failed abort) and the engine
  logs `merge:reset_interrupted`; Retry then re-merges cleanly. `checkpointIfDirty` returns null when `add -A`
  staged nothing (only a submodule dirty).
- `MergeAttempt` conflict carries `head` (target HEAD before the merge, after its checkpoint). MergeRunner aborts with
  `reset --hard <head>` (also drops a commit the resolver made with markers). Conclusion checks the merge really
  happened: strategy merge → `merge-base --is-ancestor <source> HEAD`; squash → staged changes are committed, a
  pending squash with nothing staged just drops SQUASH_MSG, otherwise HEAD must have moved. An abandoned merge
  (`git merge --abort`/reset in the shell or by Claude) fails the node; the source stays unmerged.
- Squash merges (LaneManager.merge and MergeRunner) carry the trailer `Pg-Squash-Of: <source tip>`
  (`squashMergeMessage`, `SQUASH_TRAILER`); `squashTarget` treats them as noise when that side holds only
  checkpoints/merges, so merge(squash) → commit ends in one commit like strategy merge.
- `RunnerContext.forkPoints`: baseRefs of the lane's child lanes that are still `active` (not merged back);
  `squashTarget(cwd, baseRef, keep)` never resets below them (shared history would be rewritten and merging the
  child later would conflict).
- `LaneManager.createLane` removes a branch/worktree left by an attempt that never got its lane row, and repo-level
  git writes (worktree add/remove/prune, branch -D) are serialised by a repo lock.
- `LaneManager.diff(lane, base, {committedOnly?, maxBytes?})`; `Engine.getDiff` for pr nodes diffs
  `<pr base>`'s merge-base..HEAD, committed only (= what is pushed); pr base everywhere (`ctx.baseBranch`,
  `getApprovalInfo`, `getDiff`) = non-empty trimmed `config.base`, else `settings.baseBranch`.
- PR approval is bound to the reviewed commit: `ApprovalRequest.headSha` (the web sends `DiffResponse.head`) is
  required to approve a pr gate and must equal the lane HEAD (else 409 invalid_state "The branch changed since you
  loaded the diff…"). PrRunner pushes exactly that sha as `git push origin <sha>:refs/heads/<branch>` (no `-u`; a
  fully qualified refspec, never the bare branch name); without a gate, the HEAD at push time. The validator
  rejects a `settings.branchPrefix` that is not a plain ref name (`invalid_config`).
- Web: the approval dialog derives "still waiting" from the live stores (selected run's node runs, else the pending
  list), needs the loaded diff to approve a PR, and reloads the gate on a 409. Rejected gates show the rejection
  once (card note, no error line). "Reopen session" is offered for any node run with a session (merges that used
  Claude included). diff2html: line numbers anchor to `.d2h-file-wrapper`; code lines use content-box.

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
| POST `/api/runs/:id/cancel` · `/cleanup` · `/resume` | — | `OkResponse` |
| GET `/api/pending` | — | `PendingResponse` (waiting_approval node runs) |
| POST `/api/node-runs/:id/done` · `/retry` · `/skip` | — | `NodeRunResponse` |
| POST `/api/node-runs/:id/fail` | `FailNodeRequest` | `NodeRunResponse` |
| POST `/api/node-runs/:id/hold` | `HoldNodeRequest` | `NodeRunResponse` |
| GET `/api/node-runs/:id/approval` | — | `ApprovalInfoResponse` |
| POST `/api/node-runs/:id/approval` | `ApprovalRequest` | `NodeRunResponse` |
| GET `/api/node-runs/:id/diff` | — | `DiffResponse` |
| POST `/api/node-runs/:id/reopen` | — | `ReopenResponse` |
| DELETE `/api/ptys/:ptyId` | — | `OkResponse` (ends a live reopened session; 404 otherwise) |
| GET `/api/commands` | — | `ListCommandsResponse` |
| POST `/hooks/:nodeRunId/:event` | raw hook JSON | 204 (always fast; never blocks Claude) |

**WebSocket `/ws`** (`shared/ws.ts`): upgrade checks Host/Origin + `isAuthorized` (cookie or `?t=`). Server
sends `hello` on connect. `run:update` / `graphs:changed` → all clients; `node:update` / `lane:update` → clients
subscribed to the run; `pty:*` → clients attached to that pty. `pty:attach` → `pty:attached {live, cols, rows}`,
then replay as `pty:data` chunks (≤64 KiB each), then live data. `pty:input` → `PtyManager.userInput` (live
PTYs only; else `pty:error`). Most recent attach/resize drives PTY size.

**Implementation notes (server-http, minimal extensions):**
- `localhostOnly(() => ctx.port)`: the Host (and Origin, if present) must be `127.0.0.1`, `localhost` or
  `[::1]` **on the server's port** (cookies are not port-scoped, so another localhost app must not reach the
  API/WS); the vite dev proxy rewrites Host (`changeOrigin`) and Origin. Shared with the WS upgrade as
  `isLocalRequest(host, origin, port)`. Cookie-authenticated `/api` writes must send `application/json` (403
  `forbidden_content_type`), forcing a CORS preflight for cross-origin pages.
- `/hooks/<nodeRunId>/*` also accepts `hookToken(token, nodeRunId)` (`hooks/hook-token.ts`, HMAC); that token is
  refused everywhere else. It is the only credential Claude PTYs receive.
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

**Implementation notes (web-m3m4):**
- Lanes (`lib/lanes.ts`): colour = `laneSwatch(index)` (8-colour palette, badge classes + hex). Node cards, the run
  panel legend (`LaneLegend`: branch / not created yet, state, pushed, workspace setup) and history use the
  snapshot's `computeLanePlan`, so a node shows its lane colour before the engine created the lane; created lanes
  and `nodeRun.laneId` win. `PgNodeData.lane` is `{id, index}`; `PgNodeData.mergeInputs` = merge input labels in
  merge order (`mergeInputLabels`, canvas order of the sources).
- `lib/run-view.ts`: `cardNote` (merge conflict / approval states on cards), `enteredMergeConflict` (a `node:update`
  of the shown run entering `waiting_input {kind:"merge_conflict"}` opens its `shell-<id>` PTY in the drawer),
  `runInfoOf` (history details: lanes + PR links). `RunStore.runInfo` / `loadRunInfo(runId)` load details on
  expand and refetch only when a run's status or `cleanedUp` changes. `applyNodeUpdate` drops node runs older
  (`updatedAt`) than the known one (REST responses racing WS updates).
- `AppState.pendingRuns` (runId → graph name, short id, node labels; fetched once per pending run) labels the
  header's global pending list and the approval dialog.
- Lazy chunks: `ApprovalDialog` (+ `DiffView`, diff2html) and `TerminalView` (xterm); vite `manualChunks` puts
  react/@xyflow/zustand in `vendor`. No chunk exceeds the default 500 kB warning.
- Canvas viewport (`lib/viewport.ts` `readableViewport`): fit never zooms below `FIT_MIN_ZOOM` (0.6) nor above 1;
  a graph that does not fit is aligned to its left/top. It fits once on mount (run mode; edit mode only when the
  graph has nodes) and on canvas resize **unless the user panned/zoomed** (`onMoveStart` with an event, zoom
  buttons); the custom fit button resets that.
- Replayed (not live) terminals render at `pty:attached {cols, rows}` and scroll instead of fitting; live ones fit
  and drive the PTY size. Server side, `PtyManager` writes `<log>.size.json` (`logSizePath`) with the final size
  on exit, so replays after a restart keep it (previously 120×40).
- `DiffView` heads the diff with "Changes since base <sha8>" (full merge-base sha in the tooltip); the inspector lists
  the merge order one source per line. Screenshots: `docs/screenshots/m4-*.png`.

**Implementation notes (web-flow, Phase 2 §15.6):**
- Editing (`lib/graph-ops.ts`): dragging from the red `error` handle (every node, phase 2) creates
  `{sourcePort:"error", when:"failure"}`; a phase-2 connection that closes a cycle is created as a loop back-edge
  with `DEFAULT_LOOP` `{maxIterations:3, onExhausted:"fail"}`. `setEdgeWhen` stores the default (`success` on
  non-error ports) as an absent `when`; error-port edges keep `when:"failure"` (the inspector locks it).
  `setEdgeLoop(edge, spec|null)` marks/unmarks. Edge inspector: condition (success/failure/always), loop toggle,
  max iterations, on exhausted, and the edge's validation issues; node inspector shows judge `model`/`timeoutSec`.
- Canvas (`lib/flow-mapping.ts`, `components/canvas/PgEdge.tsx`, `lib/edge-path.ts`): loop edges violet, dashed
  `8 5`; failure edges red, dashed `4 3`. A loop edge pointing backwards is routed below both nodes
  (`backEdgePath`), label on its bottom run. Edit mode pill: `always` / `on failure` / `loop ≤N[, then continue]`;
  run mode: loop badge `↺ iteration/maxIterations`. Edge tooltips list errors and warnings. Condition cards have
  labelled `true`/`false` handles (taken one highlighted in run mode) and a card note `<port> — <reason>`;
  node cards show `iter N` (1-based) when `iteration > 0`. Skipped (dead) nodes: dashed + faded; edges that
  delivered a skip (incl. an exhausted loop edge) greyed (`edgeRunState(edge, source, loop?)`).
- Loop state (`lib/run-view.ts`): `loopViews(snapshot, nodeRuns, detail.loops)` → `RunStore.loops`
  (edgeId → `{iteration, maxIterations, exhausted}`). `RunDetail.loops` (server, see `shared/run.ts LoopState`)
  wins; edges it does not list fall back to the loop target's highest node-run iteration (capped, not exhausted).
  Loop state is not pushed over WS: when `affectsLoops` (a node run of a new iteration, or a loop edge's source
  settling) the store refetches the run (debounced 150 ms) and takes only `loops` from it.
- Iterations (§15.4): `nodeIterations(nodeRuns, nodeId)` (latest attempt per iteration, ascending, attempt count)
  and `selectIterationEntry(entries, RunStore.selectedIteration)` (null / missing → latest). The run inspector
  shows an iteration selector when a node has several iterations; a previous iteration is read-only (only its
  Terminal log / Reopen session / Setup log), "Latest" returns to following the current one. `selectNode`
  to another node resets `selectedIteration`. Condition nodes in run mode: evaluator, result
  (`output.result ?? port`), reason (`output.text`). When the terminal drawer shows one of the node's iterations,
  picking another iteration switches the drawer to that iteration's terminal (tab `<label> #N`).
- Integration (M5/M6): a phase-2 connection from a `shell` to an exit-code `condition` is created with
  `when:"always"` (so a failing exit code reaches the condition; avoids the `condition_input` warning). Badge
  numbering: the edge badge is `LoopState.iteration/maxIterations` (loop-backs so far, 0-based), node cards and the
  iteration selector are 1-based passes (`iter 3` / `#3` = iteration 2). Screenshots: `docs/screenshots/m6-*.png`.

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
- Headless only: `FAKE_CLAUDE_PROMPT_LOG=<file>` appends `{argv, cwd, prompt}` per call (assert judge/message
  prompts); `FAKE_CLAUDE_RESULT=<text>` → `result` = text and no `structured_output` (a model answering in prose);
  `FAKE_CLAUDE_JUDGE_SCRIPT=<file>`: one answer per line (`true`/`false`), each headless call whose `--json-schema`
  has a boolean field consumes the first line for its booleans (a judge across loop iterations); an empty or
  missing file falls back to the defaults above. Generated commit/PR messages (no boolean field) consume nothing.

Real envelope (Claude Code 2.1.314) for reference: `structured_output` holds the parsed object, `result` the
same JSON as a string, `stop_reason`, `total_cost_usd`, `usage` (+ `cache_creation.ephemeral_1h_input_tokens`),
`modelUsage[model].costUSD`, `is_error`, `subtype:"success"`.

## 10b. fake-gh (`packages/server/test/fixtures/fake-gh`)

Use with `PG_GH_BIN=<path>` (`FAKE_GH` in `test/helpers.ts`). Only `gh --version` and `gh pr create` are emulated
(anything else exits 1). `FAKE_GH_LOG=<file>` appends
`{argv, cwd, stdin, env: GH_*/PG_*}` per call (stdin read when `--body-file -`); `FAKE_GH_FAIL=<msg>` → msg on stderr,
exit 1; `FAKE_GH_EXISTS=1` → gh's "already exists" error with the URL; `FAKE_GH_URL` (default
`https://github.com/fake/repo/pull/1`) printed on success. Push tests use a local bare repo as `origin`.

## 11. Testing

- `pnpm test` runs everything with vitest (forks pool, 20 s timeout). Put server tests in `packages/server/test/`.
  Each package also has `test` (`vitest run --root ../.. packages/<name>/`), so `pnpm -r test` works.
- End-to-end tests: `packages/server/test/e2e/` (`harness.ts`: temp repo + PG_HOME + fake claude, in-process
  `startServer`, REST + WS client). The crash-recovery case runs the CLI in a child process (`tsx
  --conditions=source`) and SIGKILLs it.
- `test/helpers.ts`: `tempDir`, `createTempRepo` (branch `main`, one commit), `fakeClaudeEnv(root)` (`PG_HOME`,
  `CLAUDE_CONFIG_DIR`, `PG_CLAUDE_BIN`), `realClaudeEnv(root)`, `waitFor`, `FAKE_CLAUDE`/`FAKE_GH` fixture paths.
- Pass env explicitly (`createAppContext({env})`, `childEnv(extra, base)`) instead of mutating `process.env`.
- Real claude tests are opt-in (`PG_REAL_CLAUDE=1`), use `realClaudeEnv` (a **copy** of `~/.claude.json` with
  `hasCompletedOnboarding: true`, `theme: "dark"`), strip env via `childEnv`, and keep prompts tiny
  ("Reply with exactly PONG"). Never modify `/root/.claude.json` / `~/.claude.json`.
- Use port 0 for servers in tests (`startServer({port: 0})`).
