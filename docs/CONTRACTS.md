# promptgraph — Internal contracts

> Audience: maintainers. `DESIGN.md` is the product spec, `SPIKE.md` overrides it where they differ. This
> file fixes **module boundaries, file paths and interfaces**. Milestones M0–M6 are implemented: every
> module listed here is complete, and its doc comment is part of the contract. Change a signature only
> together with all its callers and this file. User documentation is in the top-level `README.md`.

## 1. Workspace

```
package.json            scripts: build (pnpm -r build), dev, typecheck (pnpm -r typecheck), test (vitest run)
pnpm-workspace.yaml     packages/*, onlyBuiltDependencies: node-pty, better-sqlite3, esbuild
tsconfig.base.json      strict, NodeNext, verbatimModuleSyntax, noUncheckedIndexedAccess
vitest.config.ts        one root config; tests in packages/*/test/**/*.test.ts(x) and src/**/*.test.ts(x)
packages/shared         @promptgraph/shared — zod schemas, types, validator, topology, pricing, WS protocol
packages/server         @promptgraph/server — bin `promptgraph` (dist/cli/index.js), assets/pg-hook
packages/web            @promptgraph/web — React 19 + Vite + Tailwind v4 (built to packages/web/dist)
plugins/promptgraph     Claude Code plugin: .mcp.json (runs `promptgraph mcp`) + skills (DESIGN §19.4)
.claude-plugin          marketplace.json listing plugins/promptgraph
```

All dependencies for M1–M6 are installed. **Do not run `pnpm add`**; if something is truly missing, say so.
M7–M9 add **no npm dependency** (hand-written router; the web reaches Tauri through `window.__TAURI__`; the Tauri
CLI is installed with cargo). `packages/desktop` (`@promptgraph/desktop`) joins the workspace with `typecheck`/`test`
only — no `build` script — and Rust crates live in `packages/desktop/src-tauri/Cargo.toml` (§12.6).

| Package | Runtime deps | Dev deps |
|---|---|---|
| shared | zod 4 | typescript 7, @types/node |
| server | hono, @hono/node-server, ws, node-pty, better-sqlite3, zod, nanoid, open, @modelcontextprotocol/sdk (`promptgraph mcp`, §19) | tsx, @types/ws, @types/better-sqlite3, @types/node |
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
| `graph.ts` | `GraphSchema`, `NodeSchema` (discriminated by `type`), per-type `*ConfigSchema` with §6.1 defaults, `EdgeSchema` (`sourcePort`, Phase-2 `when`/`loop` optional), `GraphSettingsSchema` (incl. `autoTrustWorktrees` default true, `allowPrWithoutApproval` default false), `CompletionPolicySchema`, types `Graph`, `GraphInput`, `GraphNode`, `GraphNodeOf<T>`, `ClaudeNode`, `GraphEdge`, `NodeConfigMap`; helpers `defaultNodeConfig`, `resolveBranchPrefix`, `slugifyGraphId`, `edgeWhen`, `edgeMatches`, `NodeOutcome`, `compareCanvasOrder`, `createEmptyGraph`, `isClaudeNode`, `nodeDisplayLabel` (label, else id: the one fallback everywhere), `PHASE2_NODE_TYPES` + `isPhase2NodeType` (the validator and the web palette derive phase-2 handling from it) |
| `status.ts` | `NodeStatus` (§8.2; `ready` = queued), `RunStatus` (§8.3), `LaneStatus`, `ACTIVE_/FINAL_/ATTENTION_NODE_STATUSES`, `isFinalRunStatus` |
| `run.ts` | `TokenUsage`, `NodeRunOutput`, `WaitingReason`, `NodeRun`, `Lane`, `RunSummary`, `Run` (= summary + `graphSnapshot`), `RunDetail` (+ Phase-2 `loops?: LoopState[]`), `LoopState`, `RunEvent` |
| `pricing.ts` | `PRICE_TABLE`, `MODEL_ALIASES`, `priceFor`, `RawUsage`, `costFromUsage`, `emptyUsage`, `accumulateUsage`, `sumUsage`, `formatCostUsd` |
| `hooks.ts` | `HookEvent` (`session-start`/`activity`/`notification`/`stop`), `CLAUDE_HOOK_FOR_EVENT`, payload schemas, `HookPayloadMap`, `describeToolActivity` |
| `headless.ts` | `HeadlessResultSchema` (real `claude -p --output-format json` envelope), `GENERATED_MESSAGE_JSON_SCHEMA`, `JUDGE_JSON_SCHEMA` |
| `condition.ts` | `regexError(pattern, flags)` → message or null (validator + ConditionRunner) |
| `api.ts` | REST request/response schemas (§8 below), `AppSettingsSchema`, `TOKEN_COOKIE` (temporary `?t=` page flow); `RepoInfoResponseSchema` (GET `/api/repos/:repoId`: `{id, path, name, currentBranch, branches}`); daemon-wide `DaemonInfoResponseSchema` (GET `/api/daemon`: version, pid, port, startedAt, phase, supportedNodeTypes, warnings, notificationsAvailable) and `LoginCodeResponseSchema` (`{code (≥ 43 chars, 32 bytes base64url), expiresAt}`); `API` = `{hello(nonce), daemon, repos, removeRepo(repoId, force?), settings, loginCodes, rotateToken, sessions, session(idOrAll), login, ws, hook(nodeRunId, event), repo(repoId)}` where `API.repo(repoId)` (type `RepoApiPaths`) = `{info, graphs, graph(id), validate(id), startRun(id), runs, run(id), cancelRun, cleanupRun, resumeRun, runReport, laneDiff(runId, laneId), pending, nodeRunAction(id, action), approval(id), diff(id, scope), reopen(id), pty(id), commands, claudeSetup, claudeCheck}` under `/api/repos/<repoId>` (every id `encodeURIComponent`'d) |
| `ws.ts` | `ServerMessageSchema`, `ClientMessageSchema` (discriminated unions), `encodeBase64`/`decodeBase64`, `WS_CLOSE_SIGNED_OUT` (4401). Server: `repo:status {repo: RepoSummary}`, `repo:removed {repoId}`, `run:update {repoId, run}`, `graphs:changed {repoId, graphId}`, … Client: `repo:subscribe {repoId}`, `repo:unsubscribe {repoId}`, … (DESIGN §12.2) |
| `server-info.ts` | `ServerInfoSchema` → `ServerInfo` (pre-M7 per-repo record; from M7 only read to detect legacy servers, DESIGN §4.4) |
| `daemon-info.ts` | `DaemonInfoSchema` (`daemon.json`: `{version: 2, pid, pidStart, port, serverVersion, startedAt}`, no secret), `DaemonHelloResponseSchema` (`{pid, serverVersion, proof}`), `HELLO_PROOF_PREFIX` (`"hello:"`; proof = base64url(HMAC-SHA256(token, prefix + nonce))), `EXIT_DAEMON_LOCKED` (3) |
| `repos.ts` | `REPO_ID_PATTERN` (`<slug>-<hash8>`, DESIGN §4.2), `RepoIdSchema`, `RepoSummarySchema` (`{id, path, name, available, active, error, addedAt, lastOpenedAt, lastRunAt, runs: {running, paused}, waiting: {approval, input}}`; `error` = last activation failure or null, `input` counts `idle`), `ListReposResponseSchema`, `AddRepoRequestSchema` (`{path}`), `RemoveRepoQuerySchema` (`{force?: "0" \| "1"}`) |
| `sessions.ts` | `SESSION_COOKIE` (`pg_session`), `SESSION_IDLE_MS` (30 days), `LOGIN_CODE_TTL_MS` (30 s), `SessionSummarySchema` (`{id: 8 hex, label, createdAt, lastSeenAt, expiresAt, current}`), `ListSessionsResponseSchema` |
| `urls.ts` | `webRoutes` (`home`, `repo`, `graph`, `run`, `nodeRun`, `report`; every segment `encodeURIComponent`'d, DESIGN §13.2), `normalizePath` (tab dedupe key: trailing slashes stripped except `/`, each segment re-encoded as `encodeURIComponent(decodeURIComponent(seg))`, undecodable segments kept, query/fragment kept), `LOGIN_PATH`, `isSafeNextPath` (exactly one leading `/`, no `\`, no control characters or whitespace, no scheme), `safeRedirectTarget(next, origin)` (isSafeNextPath and `new URL(next, origin)` keeps the origin with no username/password and the resolved path + query + fragment, dot segments removed, passes isSafeNextPath again (so `/..//evil.com` cannot become `//evil.com`) → that resolved path, else `/`), `loginUrl(origin, code, next)` |
| `desktop.ts` | `OPEN_URL_RESULT_VERSION` (1), `OpenUrlResultSchema` (`{v: 1, cliVersion, url, port, repoId \| null}`), `DESKTOP_COMMANDS` (`relogin`), `DESKTOP_OPEN_ARGS`, `DESKTOP_PERMISSIONS`, `DESKTOP_STRIPPED_ENV`, `DESKTOP_STRIPPED_ENV_PREFIXES` (DESIGN §20) |
| `mcp-guide.ts` | `MCP_SKILLS`, `MCP_TOOL_GROUPS`, `MCP_TOOL_NAMES`, `ClaudeSetupResponseSchema`, `ClaudeCheckResponseSchema` (setup wizard content, DESIGN §19.5) |
| `topology.ts` | `buildTopology`, `findRoots`, `topologicalOrder`, `findCycle`, `ancestors`, `descendants`, `branchKey`, `edgesMutuallyExclusive`, `loopBody`, `computeLanePlan` → `LanePlan {lanes: PlannedLane[], laneOf, mergeSources, edgeLane}` |
| `validation/` | `validateGraph(graph, {phase})` → `ValidationResult {errors, warnings}` of `ValidationIssue {code, message, nodeId?, edgeId?}` |

The request/payload/config type aliases (e.g. `SaveGraphRequest`, `StartRunRequest`, `StopPayload`,
`PromptConfig`, `ServerMessageOf`) are kept on purpose as the shared package's public API, even where only the
schemas are used today. `docs/examples/*.json` must validate (`packages/shared/test/examples.test.ts`).

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
  checkpoints automatically), `empty_label`, `condition_input` (an exit-code condition fed by a
  shell through a `success` edge — a failing shell never reaches it, use `always`), `unconditional_loop`,
  `on_error_ignored`. A condition with no forward input (loop edges do not count) is an **error**
  `condition_input` (it would fail at runtime: nothing to evaluate).
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
  `CLAUDE_CODE_SYNC_SESSION_REFS`, `*HERMETIC*` and `PG_HOME` (DESIGN §7.6: children are not told where the
  token and the DB live; a child that *is* promptgraph, e.g. the server `promptgraph mcp` starts, gets `PG_HOME`
  back through `extra`), and the hook variables `PG_PORT`, `PG_HOOK_HEADER_FILE`, `PG_NODE_RUN_ID` (`PG_HOOK_ENV_VARS`:
  inherited they would be another node run's; a Claude runner passes its own through `extra`); sets `TERM=xterm-256color`.
- Claude config file: `claudeConfigFile(env)` = `$CLAUDE_CONFIG_DIR/.claude.json` else `~/.claude.json`.
- Other env: `PG_WEB_DIST` (static dir override), `PG_PORT` (vite proxy target in dev).
- Text helpers (`util/text.ts`): `stripAnsi`, `tailLines`, `truncate`.
- No module except the **engine** writes run/node-run/lane **status**; runners go through `ctx.update`.

## 4. Server module map (`packages/server/src`)

| Path | Exports |
|---|---|
| `config/paths.ts` | `pgHome`, `getPaths` → `PgPaths`, `runDir`, `ptyLogPath`, `hooksSettingsPath`, `worktreePath`, `graphsDir`, `claudeConfigFile`, `PG_HOOK_SOURCE`, `webDistDir` |
| `config/child-env.ts` | `claudeBin`, `childEnv` (strips `PG_HOME`, `PG_HOOK_ENV_VARS` and the Claude nesting variables, §3), `isClaudeNestingVar(name)`, `PgHookEnv`, `PG_HOOK_ENV_VARS` (`PG_PORT`, `PG_HOOK_HEADER_FILE`, `PG_NODE_RUN_ID`: one node run's, re-added by a Claude runner through `extra`) |
| `config/token.ts` | `tokenPath(paths)`, `loadOrCreateToken(paths)` (32 bytes base64url; exclusive atomic create: temp file 0600 hard-linked to `token`, EEXIST → the existing value wins; chmod 0600 on every call; an empty file is replaced), `writeToken(paths, token)` (temp + rename, 0600), `helloProof(token, nonce)` |
| `config/daemon-info.ts` | `daemonInfoPath`, `writeDaemonInfo` (atomic, 0600), `removeDaemonInfo(paths, pid?)` (only its own pid's record, or an unparsable one), `readDaemonInfo` (null when missing/invalid/dead pid/`pidStart` mismatch), `daemonLogPath`, `rotateDaemonLog(paths, maxBytes = DAEMON_LOG_MAX_BYTES /* 5 MiB */)` (→ `daemon.log.1`), `portFilePath`, `readStickyPort`/`writeStickyPort`, `isLegacyServerLive(info)` (pid alive, and not a reused pid: stale only when the process started more than 60 s after `startedAt` (btime + start ticks) and its `/proc/<pid>/cmdline` does not mention promptgraph; unreadable /proc → live), `findLegacyServers(paths)` (`servers/*.json` with isLegacyServerLive), `removeStaleLegacy(paths)` (deletes the other parsable `servers/*.json` only; returns the files) |
| `config/repo-id.ts` | `repoSlug(name)`, `repoIdFor(realPath)` (DESIGN §4.2) |
| `config/version.ts` | `VERSION`, `SUPPORTED_PHASE` (= 2) |
| `config/app-settings.ts` | `AppSettingsStore {get, update}` |
| `events/bus.ts` | `EventBus`, `BusEvents`, `AttentionKind` (§5) |
| `util/ids.ts`, `util/text.ts` | see §3 (`util/text.ts` also exports `errorMessage(err)`) |
| `store/schema.ts` | `MIGRATIONS` (user_version based; #2 adds `runs.loops`; #3 the `repos`, `sessions` and `meta` tables, DESIGN §11.2) |
| `store/store.ts` | `openDatabase`, `Store` DAO, `NewRun`, `RunPatch`, `NewLane`, `LanePatch`, `NewNodeRun`, `NodeRunPatch`; repositories `RepoRow`, `NewRepo`, `listRepos` (registration order), `getRepo(id)`, `getRepoByPath`, `insertRepo`, `touchRepo(id, at?)`, `deleteRepo`; `RepoStatusCounts`, `repoStatusCounts()` (one grouped query → `Map<repo_path, {running, paused, approval, input /* idle included */, lastRunAt}>`), `distinctRunRepoPaths()`, `distinctGraphMetaRepoPaths()`, `rewriteRepoPath(from, to)` (runs + graph_meta in one transaction; a graph_meta row already under `to` keeps the newer hash; returns runs moved); `getMeta`/`setMeta`; sessions `SessionRow`, `insertSession`, `getSession`, `touchSession(idHash, lastSeenAt, expiresAt)`, `listSessions` (newest first), `deleteSessions(hexPrefix \| "all")` (→ deleted hashes), `deleteExpiredSessions(now?)`; `transaction(fn)` |
| `graphs/graph-store.ts` | `GraphStore(repoPath, bus, repoId) {ensureDir, list, get, save, delete, watch}` (`graphs:changed` carries `repoId`), `GraphWatch {stop(), error}`, `GraphWatchOptions {onError?}`, `hashContent`, `serializeGraph`, `GraphNotFoundError`, `GraphLoadError`. `watch()` never throws for a watcher failure: a synchronous ENOSPC/EMFILE at start is returned as `error`, an `error` event stops the watcher and sets `error`; both go to `onError` (default: logged) |
| `git/exec.ts` | `git`, `gitOk`, `GitError`, `GitOptions.readOnly` → `READ_ONLY_GIT_CONFIG` (`-c core.fsmonitor=false`) for read-only calls: branch listing, `symbolic-ref`, status, lane diffs (incl. their throwaway index), `for-each-ref`, `worktree prune` (DESIGN §14) |
| `git/repo.ts` | `resolveRepoRoot`, `currentBranch`, `listBranches`, `revParse`, `isDirty` |
| `git/merge-state.ts` | `gitPath`, `hasMergeHead`, `hasPendingSquash`, `unmergedFiles`, `mergeInProgress` |
| `pty/ring-buffer.ts` | `RingBuffer`, `PTY_RING_BYTES` (2 MB) |
| `pty/pty-manager.ts` | `PtyManager` (+ `listOwnedBy(owner)`, `killOwnedBy(owner)` — `killAll`'s SIGTERM then SIGKILL-straggler logic for one owner, `owned(owner): OwnedPtys`), `OwnedPtys {owner, spawn, get, list, killOwned}` (stamps `SpawnPtyOptions.owner` on every spawn: node, `setup-`, `shell-`, `reopen-`; `get`/`list` see only the owner's PTYs; viewers — attach, input, resize — stay on the PtyManager), `PtyHandle`, `SpawnPtyOptions` (`owner?`), `PtyAttachResult`, `logSizePath` |
| `hooks/hook-router.ts` | `HookRouter {register, dispatch}`, `HookMessage` |
| `hooks/hook-token.ts` | `hookToken(hookSecret, nodeRunId)` (the secret is random per start, memory only, never the token: DESIGN §7.1), `sessionCookieValue(token)` (the temporary `pg_token` cookie, until login sessions) |
| `runners/types.ts` | `Runner`, `RunnerContext`, `RunnerResult`, `NodeControls`, `NodeExecution`, `PredecessorOutput`, `RunnerRegistry` |
| `runners/claude/args.ts` | `buildClaudeArgs`, `toCliPermissionMode`, `ClaudeLaunchSpec` |
| `runners/claude/context.ts` | `buildInitialMessage`, `markerInstruction`, `INTERRUPTED_MESSAGE`, `CONTEXT_OUTPUT_LIMIT` |
| `runners/claude/hooks-settings.ts` | `buildHooksSettings(pgHookPath, {pgHome})`, `writeHooksSettings(file, pgHookPath, {pgHome})` (both add `permissions.deny` = `secretDenyRules(pgHome)`: `Read`/`Edit` of `//<home>/token`, `//<home>/state.db*`, `//<home>/runs/**`, `//<home>/servers/**`, `//<home>/logs/**`, DESIGN §7.6), `secretDenyRules`, `shellQuote` |
| `runners/claude/pg-hook.ts` | `installPgHook` |
| `runners/claude/trust.ts` | `preTrustDirectory`, `TRUST_DIALOG_PATTERN` |
| `runners/claude/transcript.ts` | `lastAssistantText`, `waitForLastAssistantText`, `turnWritten`, `waitForTurnWritten`, `assistantMessageIds`, `usageFromTranscript`, `isClaudeTranscriptPath` |
| `runners/claude/completion.ts` | `CompletionController` |
| `runners/claude/headless.ts` | `runHeadless` |
| `runners/claude/claude-runner.ts` | `ClaudeRunner {start, reopen, closeReopened, isSessionActive}` (one per repository: `ClaudeRunnerDeps.ptys` is that repository's `OwnedPtys`, so node and `reopen-` PTYs are owned by it), `ClaudeRunnerDeps`, `ServerEndpoint {port, hookSecret}`, `isSessionId` |
| `runners/shell-runner.ts` | `ShellRunner`, `SHELL_TAIL_LINES` |
| `runners/git/messages.ts` | `generateMessage` |
| `runners/git/commit-runner.ts` | `CommitRunner` |
| `runners/git/merge-runner.ts` | `MergeRunner`, `MergeRunnerDeps`, `conflictPrompt`, `mergeMessage` |
| `runners/git/pr-runner.ts` | `PrRunner`, `PrRunnerDeps` |
| `runners/approval-runner.ts` | `ApprovalRunner`, `ApprovalGate`, `approvalOutput`, `rejectionError` |
| `runners/interruption.ts` | `Interruption` (stop handling shared by the approval, pr, merge, condition and commit runners) |
| `runners/condition-runner.ts` | `ConditionRunner` (+ `evaluatedPredecessor`, `evaluateExitCode`, `evaluateRegex`, `buildJudgePrompt`, `parseJudgeVerdict`, `laneDiffStat`) |
| `runners/registry.ts` | `createRunnerRegistry`, `RUNNER_NODE_TYPES` (the node types it implements: `GET /api/daemon` `supportedNodeTypes`) |
| `workspace/lane-manager.ts` | `LaneManager`, `RepoRef {id, path, name}` (`id` = `repoIdFor(path)`), `MergeAttempt` |
| `workspace/setup.ts` | `runWorkspaceSetup` |
| `engine/state.ts` | `NODE_TRANSITIONS`, `canTransition`, `assertTransition`, `RUN_TRANSITIONS` |
| `engine/activation.ts` | `ActivationTracker`, `ActivationDelta`, `LoopIteration` |
| `engine/scheduler.ts` | `Scheduler`, `SchedulerItem` |
| `engine/recovery.ts` | `markInterrupted(store, scope: InterruptScope, now?)`, `InterruptScope {repoPath?, runIds?}` (`repoPath` absent = every repository; only the daemon start uses that), `INTERRUPTED_RUN_ERROR`, `INTERRUPTED_NODE_ERROR` |
| `config/instance-lock.ts` | `DaemonLock.acquire(paths, pid?) → Promise<DaemonLock \| DaemonLockHeld {heldBy: number \| null}>` (listens on the abstract socket `daemonLockName(paths)` = `\0promptgraph-<uid>-<sha256(realpath home)[:16]>`, unref'd; EADDRINUSE → `heldBy` = live pid from `locks/daemon.pid`, else null; writes `locks/daemon.pid` for messages only), `release()`, `isDaemonLock`, `daemonPidPath`; `LegacyRepoLocks(paths, pid?) {hold(repoPath), release(repoPath), releaseAll()}` (`locks/<repoKey>.pid` = `<pid>\n<repoPath>\n`, 0600; `hold` throws `stop the promptgraph server for <repo> (pid n) first` when a live other process holds it, creates the file exclusively (temp file + hard link) and takes over a stale one only by renaming it aside and re-checking the moved file (a live owner's file is linked back), so it never overwrites a lock it has not checked; `release` removes only its own file). The pre-M7 lock logic itself only survives as a test helper (`test/support/legacy-lock.ts`) |
| `config/repo-key.ts` | `repoKey(repoPath)`: per-repository file key of the pre-M7 servers (their lock, still written by `LegacyRepoLocks`, and their `servers/` record, read by `config/daemon-info.ts`) |
| `util/process.ts` | `isProcessAlive(pid)`, `processStartTime(pid)` (`/proc/<pid>/stat` field 22, parsed after the last `)` so the command name cannot shift fields; null when gone), `isSameProcess(pid, start)`, `processStartedAtMs(pid)` (wall-clock start: `/proc/stat` btime + start ticks at USER_HZ 100; null when unreadable), `processCmdline(pid)` (`/proc/<pid>/cmdline` arguments joined with spaces, or null) |
| `engine/engine.ts` | `Engine` (+ `prune()`: `lanes.prune` + snapshot pruning, run on activation; `drain()`: resolves once every node chain settled, no timeout; `recover()` = this repository's markInterrupted + prune, tests only), `EngineDeps` (`ptys: OwnedPtys`, `repo: RepoRef`), `EngineError` |
| `notify/notifier.ts` | `Notifier`, `detectNotifyPlatform`, `sendDesktopNotification`, `attentionText` (title `promptgraph · <repo name>: <node> …`) |
| `commands/discover.ts` | `listSlashCommands` |
| `daemon/daemon-env.ts` | `daemonEnv({caller, resolveShell = true, shellTimeoutMs = 10000, node?}) → Promise<Record<string,string>>` (DESIGN §4.1 item 5: allowlisted caller variables, `CLAUDE_CONFIG_DIR` included, over the login shell's environment — `$SHELL -ilc '<node> -e "…JSON.stringify(process.env)…"'`, stdin closed, process group killed on timeout, last JSON line; `PWD`/`OLDPWD`/`SHLVL`/`_` dropped; skipped with `PG_DAEMON_SHELL_ENV=0`; caller `PATH` on failure — then `stripRuntimeEnv`), `stripRuntimeEnv(env)` (`DESKTOP_STRIPPED_ENV*` + Claude nesting variables + `PG_HOOK_ENV_VARS`, which the `PG_*` allowlist would keep), `loginShellEnv`, `lastJsonObjectLine` |
| `daemon/context.ts` | `DaemonContext {paths, env, store, bus, settings, ptys, hooks, pgHookPath, notifier, port, startedAt, hookSecret, getToken(), setToken(t), prereqWarnings(), legacyLocks, registry}`, `createDaemonContext({token, warnings?, env?})` (home 0700, `state.db` 0600, opens and migrates the DB; touches no repository; `prereqWarnings()` = the given warnings, else `checkPrereqs(env)` errors + warnings, computed once on first use), `resolvePtyLogPath` |
| `daemon/repo-context.ts` | `RepoContext {repo: RepoRef, graphs, lanes, claude, runners, engine, ptys: OwnedPtys, watchError, activate(), dispose()}`, `createRepoContext(daemon, row)`: no side effects (its own `ClaudeRunner` over `daemon.ptys.owned(repo.id)`, endpoint `{port getter, hookSecret}`; the PTY input listener); `activate` (idempotent) = `graphs.ensureDir()` + `graphs.watch({onError})` once (a watcher failure sets `watchError` and emits `repo:changed`, it never fails the activation) + `engine.prune()` once; `dispose` (memoised) = off user input + stop watcher + `engine.shutdown()` + `engine.drain()` |
| `daemon/registry.ts` | `RepoRegistry(deps {store, bus, env, legacyLocks, createContext, now?})`: `list()`, `summary(id)` (`error` = load/activation failure, else the watcher's), `row(id)`, `add(path)` (503 `daemon_stopping` once `shutdownAll` started; `~`/`~/` → HOME; not absolute → `HttpError` 422 `path_not_absolute`; `resolveRepoRoot` + realpath, failure → 422 `not_a_git_repo`; waits for a pending removal; inserts or touches; `legacyLocks.hold` (live pre-M7 holder → 409 `legacy_server_running`, a new row is deleted again); emits `repo:changed`; activates, an activation failure stays in the returned summary), `load(id)` (waits for a removal, re-checked after each wait; 503 `daemon_stopping`; 404 `unknown_repo`; 409 `repo_unavailable` when the directory is gone; memoised, cleared on failure), `activate(id)` (memoised: `legacyLocks.hold` + `ctx.activate()`; failure → summary `error`, memo cleared, thrown as 500 `activation_failed`; a context whose removal started while it loaded is never activated: waits for the removal and starts over, 404 once gone), `remove(id, {force})` (404; 409 `repo_active` with a `running` run unless `force`; `disposing` promise: dispose → delete row → release legacy lock → `repo:removed`), `backfill()` (DESIGN §4.4; git checks first, then one `store.transaction` with `rewriteRepoPath`, inserts and `meta.repos_backfilled = 1`; no-op once set), `shutdownAll()` (sets `closing`: later `load`/`activate`/`add` → 503 `daemon_stopping`; every context disposed concurrently); `REPOS_BACKFILLED_KEY` |
| `daemon/start.ts` | `startDaemon({port?, env?, warnings?, token?}) → RunningDaemon {ctx, port, origin, close()}` in the order of DESIGN §4.1 item 1 (lock → `DaemonLockedError {heldBy}`; live legacy record → `LegacyServerRunningError`, stale ones deleted; `token` given = in memory only, tests; listen: explicit port → `PortInUseError` (`code` EADDRINUSE, `Port <p> is already in use`), else `portCandidates(sticky, env)` = sticky → `PG_PORT_DEFAULT`/4777 → 0; `markInterrupted(store, {})`; `registry.backfill()`; legacy lock per registered row (failure logged); notifier; `WsHub`; `port` file; `daemon.json` with `pidStart`). `close()` (idempotent): record removed → `registry.shutdownAll()` → `ptys.killAll()` → legacy locks released → notifier, hub, HTTP, DB closed → lock released. `installProcessHandlers(daemon)` (CLI only: `unhandledRejection` logged; `uncaughtException` → `close()` → exit 1), `HOST`, `DEFAULT_PORT` |
| `daemon/client.ts` | `findDaemon(paths, {version?, fetchImpl?, timeoutMs?}) → DaemonConnection {info, token, origin, client} \| null` (record + token file → `GET /api/daemon/hello?nonce=` without credentials → proof (timing-safe) and pid checked before any Bearer request; `version` given and different → throws `DaemonVersionMismatch` (`promptgraph <old> is running (this is <new>); run promptgraph stop, then retry`)), `ensureDaemon({paths, serverCommand: argv, port?, env?, version?, timeoutMs = 20000, pollMs?}) → {…DaemonConnection, started, logFile}` (spawns `[...serverCommand, "daemon", ...(port given ? ["--port", p] : [])]` detached, cwd PG_HOME, env `daemonEnv({caller: {...env, PG_HOME}})`, stdout/stderr appended to `logs/daemon.log` after `rotateDaemonLog`; polls; child exit 3 → keeps polling (`started: false` when it is found), other exit or timeout → error with the log's last 20 lines), `registerRepo(client, path) → RepoSummary` |
| `http/auth.ts` | `tokenAuth({getToken, hookSecret})` (token read per request; `GET /api/daemon/hello` public), `localhostOnly`, `isAuthorized(token, req)` |
| `http/app.ts` | `createHttpApp(daemon) → Hono<AppEnv>` |
| `http/repo-scope.ts` | `AppEnv` (`Variables: {repo: RepoContext}`), `App`, `REPO_PREFIX` (`/api/repos/:repoId`), `registerRepoScope(app, daemon)` (`${REPO_PREFIX}/*` with a sub-path only — the bare prefix, which Hono's `/*` also matches, is skipped so `DELETE`/`GET /api/repos/:repoId` never load or activate through it: GET/HEAD → `registry.load`, anything else → `registry.activate`; `c.set("repo")`), `repoOf(c)` |
| `http/routes/daemon.ts` | `registerDaemonRoutes`: `GET /api/daemon/hello?nonce=` (16–128 base64url chars, else 400), `GET /api/daemon` |
| `http/routes/repos.ts` | `registerRepoRoutes`: `GET/POST /api/repos`, `DELETE /api/repos/:repoId?force=1`, `GET /api/repos/:repoId` (load only) |
| `http/routes/{graphs,runs,node-runs,hooks}.ts`, `misc.ts` | `register*Routes(app, daemon?)`; repository routes take their context from `repoOf(c)`; `misc.ts`: `registerSettingsRoutes` (global) and `registerRepoMiscRoutes` (commands, claude-setup, claude-setup/check) |
| `http/static.ts` | `registerStatic` (reserved: `/api`, `/hooks`, `/ws`, `/login`) |
| `ws/hub.ts` | `WsHub(daemon) {attach, close}`, `REPO_STATUS_DEBOUNCE_MS` (250) |
| `cli/args.ts` | `parseCliArgs`, `CliOptions {command: "open-repo" \| "daemon" \| "mcp", repoDir, port: number \| null /* only when given */, open, foreground, help, version}` (subcommands only at argv[0]; `--no-open`/`--foreground` only for open-repo), `USAGE` |
| `cli/prereqs.ts` | `checkPrereqs` (git, `claudeBin`, `ghBin`, curl `--version`) |
| `cli/index.ts` | `main(argv)` bin entry (auto-runs; tests must not import it): `mcp` lazily imports `mcp/server.ts`; `daemon` = foreground `startDaemon` (prints `Listening: http://127.0.0.1:<port> (pid <pid>, promptgraph <version>)`; `DaemonLockedError` → exit 3); `[repo-dir]` (bare or `--foreground`: the detached start is not implemented yet) = prereqs → `resolveRepoRoot` → `startDaemon` (lock held → exit 1) → `Listening:` → `registry.add` → `Open: http://127.0.0.1:<port>/r/<repoId>` → browser on that URL + `?t=<token>` unless `--no-open`; SIGINT/SIGTERM/SIGHUP stop it |
| `mcp/client.ts` | `PromptgraphClient {baseUrl, get, post, put, delete}` (Bearer token), `ApiRequestError` |
| `mcp/connection.ts` | `McpEnvironment {cwd, env, paths, serverCommand: argv, fetchImpl?, version?}`, `Connection {daemon, client, repoPath, repoId, api: RepoApiPaths}`, `resolveRepo` (git top level realpath, cached per directory), `findConnection` (findDaemon with the version), `connect` (no daemon → `NOT_RUNNING` = "promptgraph is not running; call start_server"; registers on first use, repoId cached per daemon pid + pidStart + path; its `client` re-registers once and retries when a repository call answers 404 `unknown_repo`, i.e. the repository was removed while the daemon kept running), `startDaemonFor(mcpEnv, repo, {port?})` (ensureDaemon + register) |
| `mcp/draft.ts` | `normalizeGraphDraft(input, {layout})` (edge ids, GraphSchema, layered auto layout over `buildTopology`/`topologicalOrder`), `GraphDraftError`, `LAYOUT_DX` |
| `mcp/format.ts` | compact views for tools: `compactRunDetail` (`attention` = nodeRunIds), `compactRunSummary`, `compactNodeRun`, `compactReport`, `compactDiff`, `latestAttempts`, `needsAttention` |
| `mcp/reference.ts` | `GRAPH_REFERENCE` (markdown), `graphJsonSchema()` |
| `mcp/setup.ts` | `buildClaudeSetup` (GET `/api/repos/:repoId/claude-setup`), `checkClaudeSetup({env?, cwd})` (POST `/api/repos/:repoId/claude-setup/check`: `claude mcp get` with `cwd` = the repository), `bundledMarketplaceRoot`, `shellQuote` |
| `mcp/tools.ts` | `registerTools(server, {mcpEnv, openUrl, pollMs?})` (tool list in DESIGN §19.3; repository calls through `Connection.api`; `server_status` → `{running, pid?, version?, port?, url?, repoPath, registered, repoId?, status?: RepoSummary, versionMismatch?}` without registering; `start_server` → `{started, repoPath, repoId, url, pid, port, logFile?}`; `open_ui` opens `<origin>/r/<repoId>?t=<token>` (temporary) and returns only `{opened, url: <origin>/r/<repoId>}`) |
| `mcp/server.ts` | `createMcpServer(deps)`, `runMcpStdio()` |


## 5. Event bus (`events/bus.ts`)

```ts
interface BusEvents {
  "run:update":     { repoId: string; run: RunSummary };  // engine, after any run change or derived counter/usage change
  "node:update":    { nodeRun: NodeRun };           // engine, after every persisted node-run change
  "lane:update":    { lane: Lane };                 // LaneManager / engine
  "pty:data":       { ptyId: string; data: Buffer }; // PtyManager
  "pty:exit":       { ptyId: string; code: number | null };
  "graphs:changed": { repoId: string; graphId: string };  // GraphStore (save/delete/watch)
  attention: { kind: "waiting_input" | "waiting_approval" | "idle"; nodeRun; nodeLabel; graphName; message: string | null;
               repo: { id: string; name: string } };
  "repo:changed":   { repoId: string };             // engine: run created, run or node-run status changed (registry: add/activate/error)
  "repo:removed":   { repoId: string };             // registry
  "session:revoked": { idHashes: string[] };        // sessions / token rotation
}
bus.emit(name, payload); const off = bus.on(name, listener);
```

Consumers: `WsHub` forwards `run:update`, `graphs:changed` (to repository subscribers), `node:update`,
`lane:update`, `pty:*`, `repo:changed` (debounced into `repo:status`) and `repo:removed` (§8; `session:revoked`
is consumed once sessions land, §12.3). `Notifier` consumes `attention` only.
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
`previousAttempt`), snapshot the worktree (§9.7, `snapshotStart`), `runners[node.type].start(ctx)`; missing runner
→ node failed "Node type not supported yet". When the runner settles, the end snapshot (`snapshotEnd`) is taken
before the scheduler releases the slot, so the next node of the lane cannot change the worktree first.
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

**Repositories**: one daemon owns the DB and runs one engine per registered repository (§4 `daemon/*`). Each
engine only touches runs of its own repository: `requireRun`/`requireNodeRun` answer `not_found` for other
repositories' runs, `/pending` and `listRunsByStatus`/`listNodeRunsByStatus` take `{repoPath}`, and shutdown
kills only the repository's own PTYs (`OwnedPtys`) and interrupts only its live runs.

**Recovery** (§8.6): the daemon start calls `markInterrupted(store, {})` once (every repository: it is the single
writer); activating a repository calls `engine.prune()` (`lanes.prune()` + snapshot pruning). `recover()`
(this repository's `markInterrupted` + `prune()`) remains for standalone engine tests. Interrupted runs are
`paused` with no in-memory state; the first retry/skip on such a run rebuilds it with
`ActivationTracker.restore` from the stored node runs and re-enqueues `pending` nodes whose inputs are resolved. Retrying an interrupted
Claude node resumes its session (`--resume <sessionId>` + `INTERRUPTED_MESSAGE`); when the interrupted attempt's
turn had already ended (it has output text and the transcript ends with an assistant text line), the session is
resumed without a message, the previous output stands and the completion policy runs as after a Stop. A retry
copies `hold` from an interrupted attempt. Skipping an interrupted merge node resets its lane's half-done merge
(`resetInterruptedMerge`); the commit runner refuses a lane that is mid-merge.

**Shutdown** (SIGINT, §4.5): `controls.cancel()` on every live execution concurrently (Claude: `/exit`, ≤3s,
kill), overall ≤5s, then `ptys.killOwned()` (this repository's PTYs only); node runs → `interrupted`, runs → `paused`, only for this engine's
live runs (`markInterrupted(store, {repoPath, runIds})`). A `cancelled` RunnerResult may carry `output` (Claude
usage so far), which is kept on the interrupted node run.

**Short ids**: `startRun` picks a `shortId` that no run of the repository and no `refs/heads/<prefix>/<shortId>/`
branch uses (`LaneManager.shortIdHasBranches`); `createLane` deletes a leftover branch only when its tip is an
ancestor of the new base, and fails otherwise (kept work is never deleted).

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
- Retry is refused (`invalid_state`) for non-latest attempts, finished runs, failures already routed downstream
  (Phase-2 failure/always edge or loop edge: `output.failureHandled`) and loop-exhaustion failures
  (`output.loopExhausted`: a retry would fail the same way; skip instead). Skip is refused for routed failures and
  for `condition` nodes ("treat as success" has no port: retry the condition, or skip the branch to follow). Skip
  also accepts `ready` (queued) nodes. `setHold` works on any non-final node run. The web hides Retry/Skip in
  those cases.
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
  port) or a loop edge matches it and loops back or is exhausted with `onExhausted:"continue"`
  (`ActivationTracker.loopHandlesFailure`); handled failures get `output.failureHandled: true` (web: card "Failed —
  handled", no Retry/Skip), advance the flow and `onError` does not apply; others
  follow `onError` (pause / fail-run). The failed node run keeps `error` + runner `output` (shell `exitCode`,
  `stdoutTail`), so `ctx.predecessors` of the failure branch carry it into the context block (§15.1).
- **Context** (`ctx.predecessors`): direct predecessors whose edge delivered an activation (all of them when none
  did, e.g. a user-skipped input), canvas order, current node runs; dead branches of an exclusive join are left out.
  A loop target in a later iteration also gets, last, the loop-source run that looped back (from the
  `loop.iteration` event). `getApprovalInfo` still lists every direct predecessor.
- **Run end**: `blockingNodeRuns` = current `interrupted`/`cancelled`, or `failed` that the tracker has not resolved
  (unhandled). Nothing blocking and everything `succeeded`/`skipped`/handled-`failed` → `succeeded`. The pause
  message is `Node "<label>" failed: <error>` (`was interrupted` / `was cancelled`). `finishNode` always runs the
  progress check, also for an execution settled earlier by cancel or a new loop iteration (it may settle last).
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
  user skipped the source early) is skipped (pending/ready) or cancelled (live; the loop target is made ready only
  once those cancels finished, bounded by `stopTimeoutMs`, so two iterations never run in the lane at once);
  `runs.loops` (= `tracker.
  loopStates()`) is persisted; event `loop.iteration {edgeId, iteration, sourceNodeRunId, targetIteration, body}`;
  `node:update` for the new node runs and `run:update`. Clients refetch `RunDetail.loops` (the web does on
  node/run updates).
- **Exhaustion**: `onExhausted:"fail"` — before persisting the source's success, `exhaustedFailLoop` turns it into
  `failed` "Loop back to "<target>" exhausted (looped back N of N times)" (output kept + `loopExhausted: true`,
  event `loop.exhausted`), routed by the source's failure edges or else `onError`. Retry is refused (it would fail
  again); **skip** (user-skip = success) continues past the loop (the edge is exhausted, so it delivers a skip like
  `continue`). `"continue"` — the loop edge delivers a skip, the loop closes and the flow continues. The same holds
  for loop edges that match a **failure** (error port, `when` failure/always): at the limit, `continue` handles the
  failure (advance with the failure → the loop closes, exhausted, held deliveries go out); `fail` leaves it to the
  source's failure edges or `onError`, and the loop is still marked exhausted (`loop.exhausted` event).
- Validation also rejects (`invalid_loop`) a loop edge whose target is an exit-code/regex condition: its forward
  predecessor is outside the body, so every pass would re-check the same output (loop back to the evaluated step).
- **Store**: migration #2 `runs.loops` (JSON `LoopState[]`, NULL without loop edges), `RunPatch.loops`,
  `Store.getLoopStates(runId)`. `RunDetail.loops` lists every loop edge (persisted state, else iteration 0).
- **Crash recovery / restore**: `ActivationTracker.restore(graph, finished, loopStates)` replays the current node
  runs (latest iteration, latest attempt) in topological order with the persisted counters, so held deliveries
  and closed loops are recomputed. A source that finished right before a crash (its new iteration never
  persisted) loops back during the replay: `takeRestoredLoops()` → the engine creates that iteration
  (`ensureLive`) and `resumeRun`/retry/skip continue. Nodes the replay resolved as dead paths whose skip was never
  persisted (crash between a node's completion and its skips, e.g. during fork-lane creation) come from
  `takeRestoredSkips()`; `ensureLive` marks their `pending` node runs `skipped`. Failed current node runs count as
  handled when a forward failure edge exists or `loopHandlesFailure` with the persisted counters.
- **RunnerContext** (optional, additive): `previousIteration` (this node's latest run of an earlier iteration that
  ran — succeeded/failed or has a session; dead-path skips are passed over) and `inLoopBody`. ClaudeRunner,
  `context:"resume"`: `previousIteration.sessionId` → resume the node's own session with the current iteration's
  context block before the prompt (e.g. the new failing output, §15.4); else the predecessor rule; with no session to resume inside a loop body (first pass after
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
- `hooks.json` once per run at `hooksSettingsPath` with commands `'<binDir>/pg-hook' <event>` (§7.2) and the
  `permissions.deny` rules for `PG_HOME`'s secrets (DESIGN §7.6).
- Spawn: `claudeBin()` with `buildClaudeArgs(spec)`, cwd = lane worktree, 120×40, env
  `childEnv({PG_PORT, PG_HOOK_HEADER_FILE, PG_NODE_RUN_ID})` (header file = `Authorization: Bearer hookToken(hookSecret, nodeRunId)`, 0600), PTY id = nodeRun.id, `logPath = ptyLogPath(...)`.
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
  `grace(ms | null)` reports the auto countdown starting / stopping → `graceUntil` (epoch ms, null when stopped);
  the engine also clears `graceUntil` when the node leaves `running`.
  `done()` from idle → success. Command nodes in marker mode get the marker instruction after the command.
- Ending (success/done/fail/cancel) → `"/exit\r"` only when Claude sits at its input prompt (a Stop and no
  activity/input/dialog since); otherwise SIGTERM directly, since Enter in a permission or trust dialog
  accepts its default "Yes". Then wait 3s, kill. PTY exit before success (and not cancelled) → failed.
- `reopen()` (async): `claude --resume <sessionId>` in a new PTY `reopen-<id>` (not part of the run), pre-trusting
  the worktree when `autoTrustWorktrees`; while it is live the same ptyId is returned. When the worktree is gone it
  runs in the main checkout with permission mode `default` and returns a `notice` (`ReopenResponse.notice`).
  `closeReopened(ptyId)` (DELETE `/api/ptys/:ptyId`) SIGTERMs it. `Engine.reopenSession` refuses (`invalid_state`)
  while a run-owned execution uses the session (`isSessionActive`); an execution that resumes a session ends a
  live reopened PTY on it first.
- Hook payloads are untrusted: a `session_id` that is not a UUID is ignored (session ids go into argv after
  `--resume`; `buildClaudeArgs` rejects ids starting with `-`), and a `transcript_path` is used only when it is an
  absolute `.jsonl` path under `~/.claude/projects` or `$CLAUDE_CONFIG_DIR/projects` (transcripts above 256 MB are
  not read). On a Stop that carries `last_assistant_message`, usage is read once the turn is in the transcript
  (`waitForTurnWritten`). No SessionStart within 45 s of the spawn → `waiting_input` (kind `other`): hooks are not
  reaching the server.

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
  `resolvePtyLogPath` must map those after a restart. PtyManager keeps the last 64 exited handles in memory;
  older ones are forgotten (attach() reads their log). Logs are written 0600, `~/.promptgraph` is 0700.
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
  - regex: fresh `RegExp(pattern, flags)` on `output.text ?? output.stdoutTail ?? error ?? ""` (last 100k chars),
    run in a `node:vm` context with a 1 s timeout (`execRegex`; catastrophic backtracking → failed "Regex
    evaluation timed out…" instead of blocking the server); invalid → failed (validator uses the same `regexError`).
  - A predecessor skipped by the user (`output.skippedByUser`) is evaluated when none ran: exitCode/regex → `true`
    ("treated as success"); judge evaluates it as usual.
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

> Auth is still the per-start Bearer token plus the temporary `?t=` page flow and the `pg_token` HMAC cookie,
> now with the persistent token of `<PG_HOME>/token` read per request; §12.3 (sessions, login codes, Fetch
> Metadata) replaces the page flow. Hook tokens derive from the per-start hook secret.

- The daemon binds `127.0.0.1:<port>`. Middleware order: `localhostOnly(() => daemon.port)` (Host/Origin must be
  `127.0.0.1:<port>` or `localhost:<port>`, else 403) → `tokenAuth({getToken, hookSecret})` (Bearer or `pg_token`
  cookie; `GET <page>?t=<token>` sets the cookie and redirects without `t`; `GET /api/daemon/hello` is public) →
  daemon routes → repository scope (`/api/repos/:repoId/*`: `registry.load`, plus `registry.activate` before any
  non-GET) → repository routes → static SPA.
- Error body is always `ApiError {error, code?, details?}`. zod body errors → 400 `code:"bad_request"`;
  `GraphNotFoundError` → 404; `GraphLoadError` → 422 `invalid_graph`; `EngineError` as in §6; registry errors as in
  §4 (`unknown_repo` 404, `repo_unavailable` 409, `path_not_absolute`/`not_a_git_repo` 422, `repo_active` 409,
  `legacy_server_running` 409, `activation_failed` 500, `daemon_stopping` 503).

Daemon routes:

| Method & path | Request | Response |
|---|---|---|
| GET `/api/daemon/hello?nonce=` | — (public) | `DaemonHelloResponse` (`proof` = `helloProof(token, nonce)`) |
| GET `/api/daemon` | — | `DaemonInfoResponse` (warnings = `prereqWarnings()`) |
| GET `/api/repos` | — | `ListReposResponse` |
| POST `/api/repos` | `AddRepoRequest` (absolute or `~/`) | `RepoSummary` (registers, idempotent, activates) |
| DELETE `/api/repos/:repoId?force=1` | `RemoveRepoQuery` | `OkResponse` |
| GET `/api/repos/:repoId` | — | `RepoInfoResponse` (loads, never activates) |
| GET `/api/settings` · PUT `/api/settings` | `UpdateAppSettingsRequest` | `AppSettings` (global) |
| POST `/hooks/:nodeRunId/:event` | raw hook JSON | 204 (always fast; never blocks Claude; unscoped) |

Repository routes, after `/api/repos/:repoId` (`API.repo(repoId)`):

| Method & path | Request | Response |
|---|---|---|
| GET `/graphs` | — | `ListGraphsResponse` |
| GET `/graphs/:id` | — | `GetGraphResponse` (`modifiedOutside` = file hash ≠ store known hash) |
| PUT `/graphs/:id` | `SaveGraphRequest` (Graph; `id` must match) | `SaveGraphResponse`; sets known hash; 409 while a run is active |
| DELETE `/graphs/:id` | — | `OkResponse`; 409 while a run is active |
| POST `/graphs/:id/validate` | `ValidateGraphRequest` (optional unsaved graph) | `ValidationResult` |
| POST `/graphs/:id/runs` | `{}` | `RunDetail` |
| GET `/runs?graph=&limit=` | `ListRunsQuery` | `ListRunsResponse` |
| GET `/runs/:id` | — | `RunDetail` |
| GET `/runs/:id/report` | — | `RunReportResponse` (§13.1) |
| GET `/runs/:id/lanes/:laneId/diff` | — | `DiffResponse` (lane vs base; after cleanup from its last snapshot) |
| POST `/runs/:id/cancel` · `/cleanup` · `/resume` | — | `OkResponse` |
| GET `/pending` | — | `PendingResponse` (waiting_approval node runs of this repository) |
| POST `/node-runs/:id/done` · `/retry` · `/skip` | — | `NodeRunResponse` |
| POST `/node-runs/:id/fail` | `FailNodeRequest` | `NodeRunResponse` |
| POST `/node-runs/:id/hold` | `HoldNodeRequest` | `NodeRunResponse` |
| GET `/node-runs/:id/approval` | — | `ApprovalInfoResponse` |
| POST `/node-runs/:id/approval` | `ApprovalRequest` | `NodeRunResponse` |
| GET `/node-runs/:id/diff?scope=lane\|node` | `DiffQuery` | `DiffResponse`; `node`: 409 without a snapshot |
| POST `/node-runs/:id/reopen` | — | `ReopenResponse` |
| DELETE `/ptys/:ptyId` | — | `OkResponse` (ends a live reopened session; 404 otherwise) |
| GET `/commands` | — | `ListCommandsResponse` |
| GET `/claude-setup` · POST `/claude-setup/check` | — | `ClaudeSetupResponse` · `ClaudeCheckResponse` (`claude mcp get` run in the repository) |

**WebSocket `/ws`** (`shared/ws.ts`, `WsHub(daemon)`): upgrade checks Host/Origin + `isAuthorized(getToken(), req)`
(Bearer, cookie or the temporary `?t=`). Server sends `hello` on connect. `repo:subscribe` adds the repository to
the client's set and activates it (`registry.activate`; a failure is sent as `error` and appears in its
`repo:status`); `run:update` / `graphs:changed` → clients subscribed to their `repoId`; `repo:changed` → debounced
250 ms per repository → `repo:status {repo: registry.summary(id)}` to every client; `repo:removed` → every client
(and dropped from every client's set); `node:update` / `lane:update` → clients subscribed to the run; `pty:*` →
clients attached to that pty. `pty:attach` → `pty:attached {live, cols, rows}`, then replay as `pty:data` chunks
(≤64 KiB each), then live data. `pty:input` → `PtyManager.userInput` (live PTYs only; else `pty:error`). Most
recent attach/resize drives PTY size.

**Implementation notes (server-http, minimal extensions):**
- `localhostOnly(() => ctx.port)`: the Host (and Origin, if present) must be `127.0.0.1`, `localhost` or
  `[::1]` **on the server's port** (cookies are not port-scoped, so another localhost app must not reach the
  API/WS); the vite dev proxy rewrites Host (`changeOrigin`) and Origin. Shared with the WS upgrade as
  `isLocalRequest(host, origin, port)`. Cookie-authenticated `/api` writes must send `application/json` (403
  `forbidden_content_type`), forcing a CORS preflight for cross-origin pages.
- `/hooks/<nodeRunId>/*` accepts the Bearer token or `hookToken(hookSecret, nodeRunId)` (`tokenAuth({getToken,
  hookSecret})`; `hooks/hook-token.ts`, HMAC of the per-start hook secret, never of the token); that hook token is
  refused everywhere else. It is the only credential Claude PTYs receive.
- Cookie name is `TOKEN_COOKIE` (`pg_token`); its value is `sessionCookieValue(token)` (HMAC, `hooks/hook-token.ts`),
  never the token: cookies are sent to every server on 127.0.0.1, and the cookie value is no Bearer credential and
  cannot derive hook tokens. `isAuthorized` also accepts `Authorization: Bearer <token>` and `?t=<token>`.
- (Replaced by DESIGN §13.5 in M8.) The web client treats a 401 (REST, or a WS connect that fails while
  `/api/daemon` answers 401) as fatal: it stops reconnecting and the header says the session ended.
- (Temporary web shim, replaced by the router in M8.) `api/rest.ts` `currentRepoId()`: the `/r/<repoId>` prefix of
  the page URL, else the most recently opened registered repository (`GET /api/repos`); every repository call goes
  through `API.repo(id)`; the app store boots from `GET /api/daemon` + `GET /api/repos/:repoId` (`RepoView`), and
  `wsClient.subscribeRepo(id)` sends `repo:subscribe` (re-sent after a reconnect).
- `DaemonContext.env`: the daemon's base env (commands discovery, `PG_WEB_DIST`, every child). `resolvePtyLogPath(store,
  paths, ptyId)` in `daemon/context.ts` maps node PTYs, `setup-`/`shell-<nodeRunId>` and (by scanning run dirs)
  `reopen-*` PTYs to their logs after a restart.
- `http/errors.ts` (new): `HttpError`, `toApiError`, `readBody(c, schema)` (empty body = `{}`), `readJson`.
  Extra codes: `unauthorized` 401, `forbidden_host` 403, `id_mismatch` 400 (PUT graph), `internal` 500.
- `AppSettingsStore.update` applies only keys present in the patch (`UpdateAppSettingsRequestSchema` is
  `.partial()` of a schema with defaults, so parsing `{}` yields `{notifications: true}`); PUT /api/settings
  validates the raw body and passes it on unparsed.
- `GET …/graphs/:id`: `modifiedOutside` is true also when no hash is known yet (never run/saved by the app).
- Hooks: unknown event → 404; everything else (unknown node run, bad payload/JSON) → 204.
- Static: unknown paths without an extension → index.html; missing files with an extension → 404;
  `/assets/*` cached immutable.
- WS: replay chunks ≤ 64 KiB; a client whose `bufferedAmount` exceeds 16 MiB is terminated (it reconnects and
  re-attaches with a fresh replay); 30 s ping heartbeat; max client frame 1 MiB.
- `checkPrereqs`: only a missing git is an error; missing claude/gh and no desktop notifier are warnings
  (DESIGN §4.2 "only warns"). The CLI checks prerequisites before `resolveRepoRoot`; `GET /api/daemon` reports
  errors and warnings of the daemon's own environment.
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

The UI is English. Only `errors` disable Run; `warnings` are shown but non-blocking. The `store/` files are
zustand stores (app, editor, run, ui) plus `app-actions.ts` (REST/WS side effects). Node names come from
`nodeDisplayLabel(node)` (shared: label, else id) everywhere.

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
  delivered a skip (incl. an exhausted loop edge) greyed (`edgeRunState(edge, source, loop?)`), except a loop edge
  that looped back in this run (`data.looped`: stays violet). Handled failures (`output.failureHandled`): muted red
  card "Failed — handled" + note. Selected edges: stroke 3.5 + blue drop-shadow halo (inline strokes override React
  Flow's selected colour). Condition port handles sit at fixed offsets (28/52 px) beside the header. The viewport
  counts as manually moved only when a user move actually changed it (a node click no longer disables auto-refit).
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
- End-to-end tests: `packages/server/test/e2e/` (`harness.ts`: temp repo + PG_HOME + fake claude; `E2eServer.start`
  = in-process `startDaemon({port: 0, env, token})` + registration; `api()`/`request()` prefix repository routes
  given as `/api/graphs/…` with `/api/repos/<repoId>`; `addRepo(path)`; `connectWs()` sends `repo:subscribe`). The
  crash-recovery cases use `spawnForegroundCli(world)`: `src/cli/index.ts <repo> --foreground --no-open --port 0`
  in a child process (`tsx --conditions=source`), `Open:` parsed, token read from `<PG_HOME>/token`, then SIGKILL.
- HTTP/WS tests: `test/support/test-daemon.ts` `createTestDaemon({root, repos, env, mockEngines})` (a real
  `DaemonContext` without HTTP server, token `TEST_TOKEN`, hook secret `TEST_HOOK_SECRET`, optional `EngineMock`
  per repository); `test/support/legacy-lock.ts` `acquirePreM7Lock` (the pre-M7 lock logic, verbatim).
- `test/helpers.ts`: `tempDir`, `createTempRepo` (branch `main`, one commit), `fakeClaudeEnv(root)` (`PG_HOME`,
  `CLAUDE_CONFIG_DIR`, `PG_CLAUDE_BIN`), `realClaudeEnv(root)`, `waitFor`, `FAKE_CLAUDE`/`FAKE_GH` fixture paths.
- Pass env explicitly (`createDaemonContext({env})`, `startDaemon({env})`, `childEnv(extra, base)`) instead of mutating `process.env`.
- Real claude tests are opt-in (`PG_REAL_CLAUDE=1`), use `realClaudeEnv` (a **copy** of `~/.claude.json` with
  `hasCompletedOnboarding: true`, `theme: "dark"`), strip env via `childEnv`, and keep prompts tiny
  ("Reply with exactly PONG"). Never modify `/root/.claude.json` / `~/.claude.json`.
- Use port 0 for daemons in tests (`startDaemon({port: 0, env})`).
- From M7: never start a daemon against the real `~/.promptgraph`; every daemon/CLI/MCP test passes a temp `PG_HOME`,
  `PG_DAEMON_SHELL_ENV=0` (no login-shell resolution) and `PG_PORT_DEFAULT=0` (no fixed port).
  Desktop contract tests (`packages/desktop/test`) read files only and never need Rust.

## 12. Daemon, multi-repo UI and desktop (M7–M9, DESIGN §4, §11–§14, §19, §20)

Target contracts. Each workstream folds the part it implements into the sections above and deletes it here.

### 12.1 Shared (`packages/shared/src`)

Implemented (§2), except: `TOKEN_COOKIE` (`pg_token`) and the `?t=` flow are deleted with login sessions.

### 12.2 Server composition

Implemented (§4 `daemon/*`), except:

| Path | Exports |
|---|---|
| `daemon/context.ts` | adds `loginCodes`, `sessions` |
| `daemon/login-codes.ts` | `LoginCodes {mint(now?): {code, expiresAt}, redeem(code, now?): boolean, clear()}` (32 bytes, TTL 30 s, single use, in memory) |
| `daemon/sessions.ts` | `Sessions {create(label, now?): string /* cookie value */, verify(value, now?): SessionRow \| null` (sliding expiry; `last_seen_at` written ≤ once/hour), `list(currentHash?)`, `revoke(idPrefix \| "all"): number`, `revokeAll()`} over `store` |
| `daemon/client.ts` | adds `mintLoginUrl(conn, next, {webPort?})` — used by the CLI and `promptgraph mcp` |
| `hooks/hook-token.ts` | `sessionCookieValue` is deleted (`hookToken(hookSecret, nodeRunId)` is implemented) |

### 12.3 HTTP and WS

Repository scoping, the daemon and repository routes and the hub's repository delivery are implemented (§8). Still to do:

- Middleware order: `localhostOnly(() => ctx.port)` → `fetchMetadata()` (cookie requests only: `/api/*`, `/ws` with `Sec-Fetch-Site` ∉ {absent, `same-origin`, `none`} or `/api/*` with `Sec-Fetch-Mode` ∈ {`no-cors`, `navigate`} → 403 `forbidden_cross_site`) → `tokenAuth({getToken, hookSecret, sessions})` → routes → static.
- `tokenAuth`: `/hooks/<nodeRunId>/*` accepts only `hookToken(hookSecret, nodeRunId)` or the Bearer token; `GET /api/daemon/hello` and `GET /login` are public; everything else needs the Bearer token or a valid `pg_session` cookie; Bearer-only routes (`login-codes`, `token/rotate`, `sessions*`) refuse cookie auth with 403 `forbidden_cookie_auth`; cookie API writes need `application/json`; an unauthenticated page gets `signedOutPage()` (401, CSP `default-src 'none'; style-src 'unsafe-inline'`, `Cache-Control: no-store`). No `?t=` anywhere.
- `GET /login`: `loginCodes.redeem` → `sessions.create(label from User-Agent)` → `Set-Cookie pg_session=<value>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` → 302 `safeRedirectTarget(next, origin)`; invalid/expired → signed-out page 401. Authenticated `index.html` responses renew the cookie and carry `Cache-Control: no-store`.
- Routes added: `POST /api/daemon/login-codes`, `POST /api/daemon/token/rotate`, `GET /api/daemon/sessions`, `DELETE /api/daemon/sessions/:id`, `GET /login`.
- `WsHub`: upgrade auth = Bearer or session cookie (Origin/Host and Fetch Metadata as HTTP; no `t` param); client state adds its session hash; rotation → `close(4401)` for every client; `session:revoked` → `close(4401)` for that session's clients.

### 12.4 CLI and MCP

- `cli/args.ts` `CliOptions.command` (`"open-repo" | "daemon" | "mcp"` and `--foreground` are implemented) adds `"ls" | "open" | "rm" | "stop" | "token-rotate" | "sessions" | "sessions-revoke"`; options `target` (repo dir or id for open/rm; session id for revoke), `json`, `printUrl`, `next`, `webPort`, `force`, `all`. Bare `promptgraph [repo-dir]` becomes the detached start (`ensureDaemon` + register + `Opened <name>: …`); today it behaves as `--foreground`. Subcommands only at argv[0] (`token rotate`, `sessions revoke` are two words). Exit codes 0/1/2, and `EXIT_DAEMON_LOCKED` (3) from `daemon`.
- `cli/commands/*.ts`: one module per command with injected deps (`{paths, env, stdout, stderr, openBrowser, now}`) so tests call them without a child process.
- Output lines (parsed by scripts/tests): foreground daemon `Listening: http://127.0.0.1:<port> (pid <pid>, promptgraph <version>)`; `--foreground` repo start additionally `Open: http://127.0.0.1:<port>/r/<repoId>`; detached repo start `Opened <name>: http://127.0.0.1:<port>/r/<repoId>`; `open --print-url --json` exactly one JSON line `OpenUrlResult`, warnings on stderr only.
- Foreground `daemon`/`--foreground` stop on SIGINT, SIGTERM and SIGHUP. `stop` checks `pidStart`, waits ≤ 30 s for the pid to exit. Offline `token rotate` holds `DaemonLock` around `writeToken`.
- MCP (discovery, registration, repository-scoped calls, `start_server`, `server_status` are implemented, §4): `open_ui` → `mintLoginUrl(next = webRoutes.repo(id))`, opens it, returns `{url: "http://127.0.0.1:<port>/r/<id>", opened}` (never the login URL).

### 12.5 Web

- `lib/router/`: `parseRoute(path) → Route` (`home | repo | graph | run | nodeRun | report | notFound`), `routeHref(route)` (via `webRoutes`), `<Link to>` (modifier/middle click → new tab), `LocationContext {path, navigate(path, {replace?}), openInNewTab(path, {activate})}`, `useRoute()` / `useNavigate()` reading the **view's** location from context (window location in M8 before tabs; the tab's location after).
- `store/view/` (M8, before tabs): `createEditorStore(repoId, graphId)` (cached and ref-counted per `${repoId}:${graphId}`; the last release flushes the pending save), `createRunStore(repoId)`, `createViewUiStore()`; `ViewProvider` + hooks `useEditor`, `useRun`, `useViewUi`, `useTabActive` (always true until tabs); `createTestView()` for tests. `store/repo-cache.ts`: per-repo store (info, graphs, commands, pending, pendingRuns, last `RepoSummary`). Global: `daemon-store` (daemon info, repos, connection `connecting|open|reconnecting|unreachable`, signedOut, versionMismatch), `toast-store`, `wsClient`.
- `store/tabs-store.ts` (after views): `Tab {id, path, title?}`, `TabsState {tabs, activeId, mru, closed}`, actions `open(path, {activate})` (dedupe on `normalizePath`; `/r/<id>` → MRU tab of that repo), `close(id)`, `activate(id)`, `navigate(id, path, {replace?})`, `next(dir)`, `goto(index | "last")`, `reopenClosed()`; persisted `sessionStorage["pg.tabs.v1"]` and mirrored to `localStorage["pg.tabs.last.v1"]` (seed only) as `{version: 1, tabs, activeId, mru}` (≤ 30 tabs, ≤ 6 mounted, LRU by `mru`, dirty editors never evicted, only the active tab mounts at load).
- `lib/keymap.ts`: `resolveKey(event, {desktop, terminalFocused}) → KeyAction | null` with `KeyAction = newTab | closeTab | reopenClosed | nextTab | prevTab | gotoTab(n) | lastTab`; matches `event.code`; ignores `AltGraph`; in terminals only tab switching.
- `api/rest.ts`: `daemonApi` (daemon routes) + `repoApi(repoId)`; 401 → `signedOut`. `api/token.ts` is deleted. `api/ws.ts`: ref-counted `subscribeRun`/`subscribeRepo` returning unsubscribe functions, close 4401 → signed out, any other close → reconnect forever with backoff ≤ 5 s; `unreachable` after 15 s.
- `vite.config.ts`: proxies `/api`, `/ws`, `/login`; `server.allowedHosts: ["127.0.0.1", "localhost"]`; rejects a present `Origin` other than the vite origin with 403 (HTTP and WS upgrade); forwards `Sec-Fetch-*`; then rewrites `Host`/`Origin` to the daemon. Never reads the token.
- `lib/desktop.ts`: `DesktopBridge {isDesktop, customTitleBar, minimize, toggleMaximize, isMaximized, close, startResizeDragging(dir), setTitle, openExternal(url), relogin(next)}`, `getDesktopBridge()` (inert outside Tauri); `installExternalLinkHandler(bridge)` (desktop only).

### 12.6 Desktop (`packages/desktop`)

```
package.json           @promptgraph/desktop: scripts typecheck, test, tauri:dev (cargo tauri dev), tauri:build; no build script
splash/index.html      static "Starting promptgraph…", window.__pgSplashError(message) + Retry (location.reload()) (frontendDist)
src-tauri/Cargo.toml   tauri 2 (pinned minor with WebviewWindowBuilder::on_new_window), tauri-plugin-opener 2, serde, serde_json
src-tauri/build.rs     tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(&["relogin"])))
src-tauri/tauri.conf.json  identifier dev.promptgraph.desktop, build.frontendDist ../splash, app.withGlobalTauri true,
                       app.windows [] (built in code), bundle targets deb/appimage
src-tauri/capabilities/    local-only defaults (no remote URLs); the remote capability is added at run time
src-tauri/src/main.rs  window built in code; on_page_load(splash) → CLI via `$SHELL -ilc 'exec "$0" "$@"'` with stripped env,
                       last JSON stdout line → OpenUrlResult (v == 1); Mutex<allowed origin>; add_capability for
                       http://127.0.0.1:<port> and …/*; on_navigation guard; on_new_window deny (+ https → opener);
                       initialization script window.__PG_DESKTOP__ = {customTitleBar}; PG_DESKTOP_DECORATIONS;
                       #[cfg(debug_assertions)] PG_DESKTOP_ORIGIN; #[tauri::command] relogin(next)
test/contract.test.ts  reads the files above and checks DESIGN §20.5 against packages/shared/src/desktop.ts
```
