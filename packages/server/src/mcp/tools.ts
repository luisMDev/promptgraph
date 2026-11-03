import {
  API,
  isFinalRunStatus,
  webRoutes,
  type ApprovalInfoResponse,
  type DiffResponse,
  type GetGraphResponse,
  type ListCommandsResponse,
  type ListGraphsResponse,
  type ListRunsResponse,
  type NodeRunResponse,
  type PendingResponse,
  type ListReposResponse,
  type RepoSummary,
  type RunDetail,
  type RunReportResponse,
  type SaveGraphResponse,
  type ValidateGraphResponse,
} from "@promptgraph/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage, truncate } from "../util/text.js";
import { DaemonVersionMismatch, findDaemon, mintLoginUrl } from "../daemon/client.js";
import { VERSION } from "../config/version.js";
import { ApiRequestError } from "./client.js";
import { connect, resolveRepo, startDaemonFor, type Connection, type McpEnvironment } from "./connection.js";
import { GraphDraftError, normalizeGraphDraft } from "./draft.js";
import { compactDiff, compactNodeRun, compactReport, compactRunDetail, compactRunSummary, latestAttempts, needsAttention } from "./format.js";
import { GRAPH_REFERENCE, graphJsonSchema } from "./reference.js";

/** server_status result (DESIGN §19.2). */
export interface ServerStatusResult {
  running: boolean;
  pid?: number;
  /** The daemon's version (from its verified hello). */
  version?: string;
  port?: number;
  repoPath: string;
  repoId?: string;
  registered: boolean;
  status?: RepoSummary;
  /** The §4.1 item 4 message when the daemon has another version than this MCP server. */
  versionMismatch?: string;
  /** What to call next. */
  hint?: string;
}

export interface ToolDeps {
  mcpEnv: McpEnvironment;
  /** Opens a URL in the user's browser (the `open` package in production). */
  openUrl: (url: string) => Promise<void>;
  /** wait_for_run poll interval. */
  pollMs?: number;
}

const repoArg = {
  repo: z.string().optional().describe("Directory inside the target git repository. Default: the project Claude Code runs in."),
};
const graphIdArg = z.string().describe("Graph id (file name without .json), see list_graphs.");
const runIdArg = z.string().describe("Run id, from start_run or list_runs.");
const nodeRunIdArg = z.string().describe("Node run id (nodeRunId in get_run steps).");

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

function describeError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const details = err.details === undefined ? "" : `\ndetails: ${truncate(JSON.stringify(err.details, null, 2), 4000)}`;
    return `promptgraph API error ${err.status}${err.code ? ` (${err.code})` : ""}: ${err.message}${details}`;
  }
  if (err instanceof GraphDraftError) return `${err.message}\nSee graph_reference for the format.`;
  return errorMessage(err);
}

/** Wraps a handler: errors become `isError` results Claude can read and act on. */
function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(describeError(err));
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

/**
 * Registers the promptgraph tools (§19.3). Every call re-reads the daemon record and the token file and
 * verifies the daemon before sending the token (§19.1), so a restarted daemon (possibly on another port)
 * or a rotated token is picked up transparently. Approvals are read-only here: approving or
 * rejecting a gate stays a human action in the UI (invariant 4).
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { mcpEnv } = deps;
  const pollMs = deps.pollMs ?? 1500;
  const conn = (repo?: string): Promise<Connection> => connect(mcpEnv, repo);

  // --- Server ---------------------------------------------------------------

  server.registerTool(
    "server_status",
    {
      title: "promptgraph status",
      description:
        "Whether the promptgraph daemon is running (pid, version, port), whether this repository is registered with it, its repoId and its counters (running/paused runs, steps waiting). Call first.",
      inputSchema: repoArg,
      annotations: READ,
    },
    guarded(async ({ repo }) => {
      const repoPath = await resolveRepo(mcpEnv, repo);
      const found = await findDaemon(mcpEnv.paths, { fetchImpl: mcpEnv.fetchImpl });
      if (!found) {
        return json({
          running: false,
          repoPath,
          registered: false,
          hint: "Call start_server to start the promptgraph daemon in the background (no browser opens), then open_ui if the user wants to watch.",
        } satisfies ServerStatusResult);
      }
      const version = mcpEnv.version ?? VERSION;
      const base = { running: true, pid: found.info.pid, version: found.serverVersion, port: found.info.port, repoPath } as const;
      if (found.serverVersion !== version) {
        return json({ ...base, registered: false, versionMismatch: new DaemonVersionMismatch(found.serverVersion, version).message } satisfies ServerStatusResult);
      }
      const { repos } = await found.client.get<ListReposResponse>(API.repos);
      const status = repos.find((r) => r.path === repoPath);
      return json(
        (status
          ? { ...base, registered: true, repoId: status.id, status }
          : { ...base, registered: false, hint: "Any other tool registers this repository." }) satisfies ServerStatusResult,
      );
    }),
  );

  server.registerTool(
    "start_server",
    {
      title: "Start promptgraph",
      description:
        "Starts the promptgraph daemon if needed (it keeps running after this session; stop it with `promptgraph stop`) and registers this repository. No browser opens.",
      inputSchema: {
        ...repoArg,
        port: z.number().int().min(0).max(65535).optional().describe("Port on 127.0.0.1, only used when this call starts the daemon. Default: its last port, else 4777, else any free port."),
      },
      annotations: WRITE,
    },
    guarded(async ({ repo, port }) => {
      const { connection: c, daemon } = await startDaemonFor(mcpEnv, repo, { port });
      return json({
        started: daemon.started,
        repoPath: c.repoPath,
        repoId: c.repoId,
        url: `${daemon.origin}${webRoutes.repo(c.repoId)}`,
        pid: daemon.info.pid,
        port: daemon.info.port,
        ...(daemon.started ? { logFile: daemon.logFile } : {}),
        ...(port !== undefined && !daemon.started && port !== daemon.info.port ? { warning: `The daemon was already running on port ${daemon.info.port}; port ${port} was not used.` } : {}),
        hint: "open_ui opens this repository in the browser.",
      });
    }),
  );

  server.registerTool(
    "open_ui",
    {
      title: "Open the promptgraph UI",
      description: "Opens this repository in promptgraph in the user's browser, signed in. Use when the user wants to watch a run, answer a terminal prompt or approve a gate.",
      inputSchema: repoArg,
      annotations: { ...WRITE, idempotentHint: true },
    },
    guarded(async ({ repo }) => {
      const c = await conn(repo);
      const url = `${c.daemon.origin}${webRoutes.repo(c.repoId)}`;
      // A one-time login URL signs the browser in (DESIGN §19.1); only the plain URL is returned,
      // because tool results go to the model provider.
      let login: string | null = null;
      try {
        login = await mintLoginUrl(c.daemon, webRoutes.repo(c.repoId));
        await deps.openUrl(login);
        return json({ opened: true, url });
      } catch (err) {
        const message = login === null ? errorMessage(err) : errorMessage(err).split(login).join("<login URL>");
        return json({ opened: false, url, error: message, hint: "Run `promptgraph open` in a terminal." });
      }
    }),
  );

  // --- Graphs ---------------------------------------------------------------

  server.registerTool(
    "graph_reference",
    {
      title: "Graph format reference",
      description: "The promptgraph graph format: node types and their config, edges, ports, conditions, loops and validation rules. Read before writing a graph.",
      inputSchema: { format: z.enum(["guide", "json-schema"]).default("guide").describe("guide: concise markdown. json-schema: the exact input schema.") },
      annotations: READ,
    },
    guarded(async ({ format }) =>
      format === "json-schema" ? json(graphJsonSchema()) : { content: [{ type: "text", text: GRAPH_REFERENCE }] },
    ),
  );

  server.registerTool(
    "list_graphs",
    { title: "List graphs", description: "Graphs saved in the repository (.promptgraph/graphs).", inputSchema: repoArg, annotations: READ },
    guarded(async ({ repo }) => {
      const c = await conn(repo);
      return json((await c.client.get<ListGraphsResponse>(c.api.graphs)).graphs);
    }),
  );

  server.registerTool(
    "get_graph",
    {
      title: "Get graph",
      description: "The full graph JSON, plus whether a run is active on it (then it is read-only).",
      inputSchema: { ...repoArg, graphId: graphIdArg },
      annotations: READ,
    },
    guarded(async ({ repo, graphId }) => {
      const c = await conn(repo);
      return json(await c.client.get<GetGraphResponse>(c.api.graph(graphId)));
    }),
  );

  server.registerTool(
    "save_graph",
    {
      title: "Create or update a graph",
      description:
        "Saves a whole graph (create or replace) and returns its validation. Node positions and edge ids may be omitted (auto layout). " +
        "Read graph_reference first. Refused while a run of the graph is active. The UI updates live.",
      inputSchema: {
        ...repoArg,
        graph: z.looseObject({}).describe("Graph JSON: { id, name, settings?, nodes: [{ id, type, label, config, position? }], edges: [{ source, target, sourcePort?, when?, loop? }] }"),
        layout: z.enum(["missing", "all", "keep"]).default("missing").describe("Auto layout: nodes without a position (missing), every node (all), or none (keep)."),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    guarded(async ({ repo, graph, layout }) => {
      const normalized = normalizeGraphDraft(graph, { layout });
      const c = await conn(repo);
      const client = c.client;
      const saved = await client.put<SaveGraphResponse>(c.api.graph(normalized.id), normalized);
      const validation = await client.post<ValidateGraphResponse>(c.api.validate(saved.graph.id), { graph: saved.graph });
      return json({
        saved: true,
        graphId: saved.graph.id,
        file: `.promptgraph/graphs/${saved.graph.id}.json`,
        nodes: saved.graph.nodes.length,
        edges: saved.graph.edges.length,
        runnable: validation.errors.length === 0,
        validation,
      });
    }),
  );

  server.registerTool(
    "validate_graph",
    {
      title: "Validate graph",
      description: "Validation errors (block running) and warnings of a saved graph, or of an unsaved draft when `graph` is given.",
      inputSchema: { ...repoArg, graphId: graphIdArg.optional(), graph: z.looseObject({}).optional().describe("Unsaved draft to validate instead of the file.") },
      annotations: READ,
    },
    guarded(async ({ repo, graphId, graph }) => {
      const c = await conn(repo);
      const client = c.client;
      if (graph) {
        const draft = normalizeGraphDraft(graph);
        return json(await client.post<ValidateGraphResponse>(c.api.validate(draft.id), { graph: draft }));
      }
      if (!graphId) return fail("Pass graphId (a saved graph) or graph (a draft).");
      return json(await client.post<ValidateGraphResponse>(c.api.validate(graphId)));
    }),
  );

  server.registerTool(
    "delete_graph",
    {
      title: "Delete graph",
      description: "Deletes a graph file from the repository. Run history is kept. Confirm with the user first.",
      inputSchema: { ...repoArg, graphId: graphIdArg },
      annotations: DESTRUCTIVE,
    },
    guarded(async ({ repo, graphId }) => {
      const c = await conn(repo);
      return json(await c.client.delete(c.api.graph(graphId)));
    }),
  );

  server.registerTool(
    "list_commands",
    {
      title: "List slash commands",
      description: "Slash commands and skills available to `command` nodes in this repository (project, user, plugin, built-in).",
      inputSchema: { ...repoArg, query: z.string().optional().describe("Case-insensitive filter on name and description.") },
      annotations: READ,
    },
    guarded(async ({ repo, query }) => {
      const c = await conn(repo);
      const { commands } = await c.client.get<ListCommandsResponse>(c.api.commands);
      const q = query?.toLowerCase();
      const hits = q ? commands.filter((c) => `${c.name} ${c.description ?? ""}`.toLowerCase().includes(q)) : commands;
      return json({ total: hits.length, commands: hits.slice(0, 80).map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, source: c.source })) });
    }),
  );

  // --- Runs -----------------------------------------------------------------

  server.registerTool(
    "start_run",
    {
      title: "Run a graph",
      description:
        "Starts a run of a saved graph: Claude sessions, shell commands and git steps run in worktrees under ~/.promptgraph. " +
        "Fails with the validation result when the graph has errors. Then use wait_for_run.",
      inputSchema: { ...repoArg, graphId: graphIdArg },
      annotations: WRITE,
    },
    guarded(async ({ repo, graphId }) => {
      const c = await conn(repo);
      const detail = await c.client.post<RunDetail>(c.api.startRun(graphId));
      return json(compactRunDetail(detail));
    }),
  );

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description: "Run history of the repository, newest first.",
      inputSchema: { ...repoArg, graphId: graphIdArg.optional(), limit: z.number().int().min(1).max(100).default(10) },
      annotations: READ,
    },
    guarded(async ({ repo, graphId, limit }) => {
      const c = await conn(repo);
      const qs = new URLSearchParams({ limit: String(limit), ...(graphId ? { graph: graphId } : {}) });
      const { runs } = await c.client.get<ListRunsResponse>(`${c.api.runs}?${qs}`);
      return json(runs.map(compactRunSummary));
    }),
  );

  server.registerTool(
    "get_run",
    {
      title: "Get run",
      description: "Current state of a run: status, the steps (latest attempt of each), which need attention, lanes, and a hint of what to do next.",
      inputSchema: { ...repoArg, runId: runIdArg },
      annotations: READ,
    },
    guarded(async ({ repo, runId }) => {
      const c = await conn(repo);
      return json(compactRunDetail(await c.client.get<RunDetail>(c.api.run(runId))));
    }),
  );

  server.registerTool(
    "wait_for_run",
    {
      title: "Wait for a run",
      description:
        "Blocks until the run finishes, pauses, or (until=attention, the default) a step needs the user, or the timeout elapses. " +
        "Returns the run state like get_run. Call again to keep waiting.",
      inputSchema: {
        ...repoArg,
        runId: runIdArg,
        until: z.enum(["attention", "finished"]).default("attention"),
        timeoutSec: z.number().int().min(1).max(600).default(240),
      },
      annotations: READ,
    },
    guarded(async ({ repo, runId, until, timeoutSec }) => {
      const c = await conn(repo);
      const started = Date.now();
      const deadline = started + timeoutSec * 1000;
      for (;;) {
        const detail = await c.client.get<RunDetail>(c.api.run(runId));
        const status = detail.run.status;
        const stop =
          isFinalRunStatus(status) ||
          status === "paused" ||
          (until === "attention" && latestAttempts(detail).some((s) => needsAttention(s.status)));
        const timedOut = Date.now() >= deadline;
        if (stop || timedOut) {
          return json({ waitedSec: Math.round((Date.now() - started) / 1000), timedOut: !stop && timedOut, ...compactRunDetail(detail) });
        }
        await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
      }
    }),
  );

  server.registerTool(
    "get_node_output",
    {
      title: "Get step output",
      description: "Full output of one step (Claude's last message, shell output tail, commit, PR, condition reason), its error and its attempts.",
      inputSchema: {
        ...repoArg,
        runId: runIdArg,
        nodeId: z.string().optional().describe("Node id in the graph; with iteration selects that step."),
        nodeRunId: nodeRunIdArg.optional(),
        iteration: z.number().int().min(0).optional().describe("Loop iteration (default: the latest)."),
        maxChars: z.number().int().min(200).max(50_000).default(8000),
      },
      annotations: READ,
    },
    guarded(async ({ repo, runId, nodeId, nodeRunId, iteration, maxChars }) => {
      const c = await conn(repo);
      const detail = await c.client.get<RunDetail>(c.api.run(runId));
      const picked = nodeRunId
        ? detail.nodeRuns.find((nr) => nr.id === nodeRunId)
        : latestAttempts(detail)
            .filter((nr) => nr.nodeId === nodeId && (iteration === undefined || nr.iteration === iteration))
            .sort((a, b) => b.iteration - a.iteration)[0];
      if (!picked) return fail(nodeRunId || nodeId ? `No such step in run ${runId}.` : "Pass nodeId or nodeRunId.");
      const node = detail.run.graphSnapshot.nodes.find((n) => n.id === picked.nodeId);
      const attempts = detail.nodeRuns
        .filter((nr) => nr.nodeId === picked.nodeId && nr.iteration === picked.iteration)
        .sort((a, b) => a.attempt - b.attempt)
        .map((nr) => ({ nodeRunId: nr.id, attempt: nr.attempt, status: nr.status, error: nr.error }));
      return json({
        ...compactNodeRun(picked, node, maxChars),
        sessionId: picked.sessionId,
        attempts,
        config: node?.config,
      });
    }),
  );

  server.registerTool(
    "node_action",
    {
      title: "Control a step",
      description:
        "Manual control of one step: done (mark a live step succeeded), fail, retry (new attempt of a failed/interrupted step), " +
        "skip (treat as succeeded), hold / release (hold the auto-completion of a Claude step). Approvals are not done here.",
      inputSchema: {
        ...repoArg,
        nodeRunId: nodeRunIdArg,
        action: z.enum(["done", "fail", "retry", "skip", "hold", "release"]),
        reason: z.string().optional().describe("fail: why."),
      },
      annotations: WRITE,
    },
    guarded(async ({ repo, nodeRunId, action, reason }) => {
      const c = await conn(repo);
      const client = c.client;
      const hold = action === "hold" || action === "release";
      const body = hold ? { hold: action === "hold" } : action === "fail" ? { reason } : undefined;
      const res = await client.post<NodeRunResponse>(c.api.nodeRunAction(nodeRunId, hold ? "hold" : action), body);
      return json(compactNodeRun(res.nodeRun, undefined));
    }),
  );

  server.registerTool(
    "get_diff",
    {
      title: "Get changes",
      description: "What a step changed (scope node), its whole lane vs the base branch (scope lane), or a lane of a run (runId + laneId).",
      inputSchema: {
        ...repoArg,
        nodeRunId: nodeRunIdArg.optional(),
        scope: z.enum(["node", "lane"]).default("node"),
        runId: runIdArg.optional(),
        laneId: z.string().optional(),
        maxChars: z.number().int().min(500).max(200_000).default(20_000),
      },
      annotations: READ,
    },
    guarded(async ({ repo, nodeRunId, scope, runId, laneId, maxChars }) => {
      const c = await conn(repo);
      const client = c.client;
      let diff: DiffResponse;
      if (nodeRunId) diff = await client.get<DiffResponse>(c.api.diff(nodeRunId, scope));
      else if (runId && laneId) diff = await client.get<DiffResponse>(c.api.laneDiff(runId, laneId));
      else return fail("Pass nodeRunId (with scope), or runId and laneId.");
      return json(compactDiff(diff, maxChars));
    }),
  );

  server.registerTool(
    "get_run_report",
    {
      title: "Run report",
      description: "What happened in a run: result, duration, cost, where it stopped or waited, each step's result and changes, pull requests and lanes.",
      inputSchema: { ...repoArg, runId: runIdArg },
      annotations: READ,
    },
    guarded(async ({ repo, runId }) => {
      const c = await conn(repo);
      return json(compactReport(await c.client.get<RunReportResponse>(c.api.runReport(runId))));
    }),
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel run",
      description: "Cancels a running or paused run: live Claude sessions and commands are stopped. Confirm with the user first.",
      inputSchema: { ...repoArg, runId: runIdArg },
      annotations: DESTRUCTIVE,
    },
    guarded(async ({ repo, runId }) => {
      const c = await conn(repo);
      const client = c.client;
      await client.post(c.api.cancelRun(runId));
      return json(compactRunSummary((await client.get<RunDetail>(c.api.run(runId))).run));
    }),
  );

  server.registerTool(
    "resume_run",
    {
      title: "Resume run",
      description: "Continues a paused run (e.g. after the promptgraph daemon was stopped or crashed). Failed or interrupted steps still need node_action retry or skip.",
      inputSchema: { ...repoArg, runId: runIdArg },
      annotations: WRITE,
    },
    guarded(async ({ repo, runId }) => {
      const c = await conn(repo);
      const client = c.client;
      await client.post(c.api.resumeRun(runId));
      return json(compactRunDetail(await client.get<RunDetail>(c.api.run(runId))));
    }),
  );

  server.registerTool(
    "cleanup_run",
    {
      title: "Clean up run",
      description: "Removes a finished run's worktrees and its unpushed lane branches (pushed branches stay). Confirm with the user first.",
      inputSchema: { ...repoArg, runId: runIdArg },
      annotations: DESTRUCTIVE,
    },
    guarded(async ({ repo, runId }) => {
      const c = await conn(repo);
      await c.client.post(c.api.cleanupRun(runId));
      return json({ ok: true, runId });
    }),
  );

  // --- Approvals (read-only) --------------------------------------------------

  server.registerTool(
    "list_pending",
    {
      title: "Pending approvals",
      description: "Steps waiting for a human approval across the repository's runs. The user approves or rejects them in the UI.",
      inputSchema: repoArg,
      annotations: READ,
    },
    guarded(async ({ repo }) => {
      const c = await conn(repo);
      const { nodeRuns } = await c.client.get<PendingResponse>(c.api.pending);
      return json(nodeRuns.map((nr) => ({ runId: nr.runId, ...compactNodeRun(nr, undefined) })));
    }),
  );

  server.registerTool(
    "get_approval",
    {
      title: "Get approval request",
      description:
        "What an approval or PR gate asks the user to approve: message, proposed PR title/body, predecessor outputs. " +
        "Use get_diff (scope lane) for the changes. Approving is a human action in the UI (open_ui).",
      inputSchema: { ...repoArg, nodeRunId: nodeRunIdArg },
      annotations: READ,
    },
    guarded(async ({ repo, nodeRunId }) => {
      const c = await conn(repo);
      const info = await c.client.get<ApprovalInfoResponse>(c.api.approval(nodeRunId));
      return json({
        ...compactNodeRun(info.nodeRun, undefined),
        message: info.message,
        pr: info.pr,
        predecessorOutputs: info.predecessorOutputs.map((p) => ({ ...p, text: truncate(p.text, 2000) })),
        howToApprove: "Ask the user to approve or reject it in the promptgraph UI (open_ui).",
      });
    }),
  );
}

