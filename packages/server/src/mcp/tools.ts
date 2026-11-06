import {
  API,
  GRAPH_CONFLICT_CODE,
  GraphPatchError,
  GraphPatchSchema,
  applyGraphPatch,
  isFinalRunStatus,
  type ApprovalInfoResponse,
  type DiffResponse,
  type GetGraphResponse,
  type ListCommandsResponse,
  type ListGraphsResponse,
  type ListRunsResponse,
  type NodeRunResponse,
  type PendingResponse,
  type RepoInfoResponse,
  type RunDetail,
  type RunReportResponse,
  type SaveGraphResponse,
  type ValidateGraphResponse,
} from "@promptgraph/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage, truncate } from "../util/text.js";
import { ApiRequestError, type PromptgraphClient } from "./client.js";
import { connect, findServer, resolveRepo, startBackgroundServer, type Connection, type McpEnvironment } from "./connection.js";
import { GraphDraftError, normalizeGraphDraft } from "./draft.js";
import { compactDiff, compactNodeRun, compactReport, compactRunDetail, compactRunSummary, latestAttempts, needsAttention } from "./format.js";
import { GRAPH_REFERENCE, graphJsonSchema } from "./reference.js";

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
  if (err instanceof GraphPatchError) return `patch_graph (${err.code}): ${err.message}\nNothing was saved. Fix the ops (get_graph shows the current ids) and retry.`;
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
 * Registers the promptgraph tools (§19.3). Every call re-reads the server-info record, so a restarted
 * server (new port and token) is picked up transparently. Approvals are read-only here: approving or
 * rejecting a gate stays a human action in the UI (invariant 4).
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { mcpEnv } = deps;
  const pollMs = deps.pollMs ?? 1500;
  const conn = (repo?: string): Promise<Connection> => connect(mcpEnv, repo);
  const api = async (repo?: string): Promise<PromptgraphClient> => (await conn(repo)).client;

  // --- Server ---------------------------------------------------------------

  server.registerTool(
    "server_status",
    {
      title: "promptgraph server status",
      description: "Whether a promptgraph server is running for the repository, and its repo info (branches, supported node types, warnings). Call first.",
      inputSchema: repoArg,
      annotations: READ,
    },
    guarded(async ({ repo }) => {
      const repoPath = await resolveRepo(mcpEnv, repo);
      const found = findServer(mcpEnv, repoPath);
      if (!found) return json({ running: false, repoPath, hint: "Call start_server to start promptgraph in the background (no browser opens), then open_ui if the user wants to watch." });
      const info = await found.client.get<RepoInfoResponse>(API.repo);
      return json({ running: true, repoPath, url: found.client.baseUrl, pid: found.info.pid, startedAt: new Date(found.info.startedAt).toISOString(), repo: info });
    }),
  );

  server.registerTool(
    "start_server",
    {
      title: "Start promptgraph",
      description:
        "Starts `promptgraph <repo> --no-open` in the background (it keeps running after this session ends; stop it with Ctrl-C in a terminal or `kill <pid>`). No-op when one is already running.",
      inputSchema: { ...repoArg, port: z.number().int().min(0).max(65535).optional().describe("Port on 127.0.0.1. Default: any free port.") },
      annotations: WRITE,
    },
    guarded(async ({ repo, port }) => {
      const repoPath = await resolveRepo(mcpEnv, repo);
      const started = await startBackgroundServer(mcpEnv, repoPath, { port });
      const c = started.connection;
      return json({
        started: !started.alreadyRunning,
        repoPath,
        url: c.client.baseUrl,
        pid: c.info.pid,
        ...(started.logFile ? { logFile: started.logFile } : {}),
        hint: "open_ui opens the canvas in the browser with the session token.",
      });
    }),
  );

  server.registerTool(
    "open_ui",
    {
      title: "Open the promptgraph UI",
      description: "Opens the promptgraph canvas in the user's browser, already authenticated. Use when the user wants to watch a run, answer a terminal prompt or approve a gate.",
      inputSchema: repoArg,
      annotations: { ...WRITE, idempotentHint: true },
    },
    guarded(async ({ repo }) => {
      const c = await conn(repo);
      const url = `${c.client.baseUrl}/?t=${encodeURIComponent(c.info.token)}`;
      try {
        await deps.openUrl(url);
        return json({ opened: true, url: c.client.baseUrl });
      } catch (err) {
        // The user owns this server; give them the link to open by hand.
        return json({ opened: false, error: errorMessage(err), openThisUrl: url });
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
    guarded(async ({ repo }) => json((await (await api(repo)).get<ListGraphsResponse>(API.graphs)).graphs)),
  );

  server.registerTool(
    "get_graph",
    {
      title: "Get graph",
      description: "The full graph JSON, plus whether a run is active on it (then it is read-only).",
      inputSchema: { ...repoArg, graphId: graphIdArg },
      annotations: READ,
    },
    guarded(async ({ repo, graphId }) => json(await (await api(repo)).get<GetGraphResponse>(API.graph(graphId)))),
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
      const client = await api(repo);
      // Invariant 4: an agent must not unlock PRs without approval. Only the user can, in the UI; a
      // graph that is already unlocked on disk keeps its setting.
      if (normalized.settings.allowPrWithoutApproval) {
        const existing = await client.get<GetGraphResponse>(API.graph(normalized.id)).catch(() => null);
        if (!existing?.graph.settings.allowPrWithoutApproval) {
          return fail(
            "settings.allowPrWithoutApproval cannot be turned on from Claude: PR nodes keep their approval gate. " +
              "Save the graph without it; the user can unlock it in the promptgraph UI (graph settings) if they want to.",
          );
        }
      }
      const saved = await client.put<SaveGraphResponse>(API.graph(normalized.id), normalized);
      const validation = await client.post<ValidateGraphResponse>(API.validate(saved.graph.id), { graph: saved.graph });
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
    "patch_graph",
    {
      title: "Edit a graph",
      description:
        "Applies incremental edits to a saved graph: add_node, update_node (shallow config merge, null deletes a key), remove_node " +
        "(bridges predecessors to the success successors by default; failure / always handlers go with the node), connect, disconnect, " +
        "insert_after (takes over the success edges of the anchor), insert_before. Unknown config fields are rejected. Ops apply in order and " +
        "all-or-nothing; existing nodes keep their ids and positions, new nodes get an id and a position when omitted. Prefer this over " +
        "save_graph for any change to an existing graph. Refused while a run of the graph is active. The UI updates live and can undo it.",
      inputSchema: {
        ...repoArg,
        graphId: graphIdArg,
        ops: GraphPatchSchema.describe("Edits, applied in order. Node config fields per type: graph_reference."),
      },
      // Removals are not destructive: the user undoes them in the UI.
      annotations: WRITE,
    },
    guarded(async ({ repo, graphId, ops }) => {
      const client = await api(repo);
      const current = await client.get<GetGraphResponse>(API.graph(graphId));
      if (current.activeRunId) {
        return fail(`Graph "${graphId}" is read-only while run ${current.activeRunId} is active. Wait for it to finish (or ask the user to cancel it) and retry.`);
      }
      const patched = applyGraphPatch(current.graph, ops);
      let saved: SaveGraphResponse;
      try {
        saved = await client.put<SaveGraphResponse>(API.saveGraph(graphId, current.hash), patched.graph);
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === GRAPH_CONFLICT_CODE) {
          return fail(`The graph "${graphId}" changed while it was being patched (the user may be editing it). Nothing was saved. Call get_graph again, rebuild the ops against the current graph and retry.`);
        }
        throw err;
      }
      const validation = await client.post<ValidateGraphResponse>(API.validate(graphId), { graph: saved.graph });
      const nodeLabels = (ids: string[]) =>
        ids.map((id) => {
          const node = saved.graph.nodes.find((n) => n.id === id);
          return node ? { id, type: node.type, label: node.label } : { id };
        });
      return json({
        saved: true,
        graphId,
        added: nodeLabels(patched.added),
        removed: patched.removed,
        updated: nodeLabels(patched.updated),
        edges: { added: patched.addedEdges, removed: patched.removedEdges, rewired: patched.updatedEdges },
        nodes: saved.graph.nodes.length,
        edgeCount: saved.graph.edges.length,
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
      const client = await api(repo);
      if (graph) {
        const draft = normalizeGraphDraft(graph);
        return json(await client.post<ValidateGraphResponse>(API.validate(draft.id), { graph: draft }));
      }
      if (!graphId) return fail("Pass graphId (a saved graph) or graph (a draft).");
      return json(await client.post<ValidateGraphResponse>(API.validate(graphId)));
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
    guarded(async ({ repo, graphId }) => json(await (await api(repo)).delete(API.graph(graphId)))),
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
      const { commands } = await (await api(repo)).get<ListCommandsResponse>(API.commands);
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
      const detail = await (await api(repo)).post<RunDetail>(API.startRun(graphId));
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
      const qs = new URLSearchParams({ limit: String(limit), ...(graphId ? { graph: graphId } : {}) });
      const { runs } = await (await api(repo)).get<ListRunsResponse>(`${API.runs}?${qs}`);
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
    guarded(async ({ repo, runId }) => json(compactRunDetail(await (await api(repo)).get<RunDetail>(API.run(runId))))),
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
      const started = Date.now();
      const deadline = started + timeoutSec * 1000;
      for (;;) {
        const detail = await (await api(repo)).get<RunDetail>(API.run(runId));
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
      const detail = await (await api(repo)).get<RunDetail>(API.run(runId));
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
      const client = await api(repo);
      const hold = action === "hold" || action === "release";
      const body = hold ? { hold: action === "hold" } : action === "fail" ? { reason } : undefined;
      const res = await client.post<NodeRunResponse>(API.nodeRunAction(nodeRunId, hold ? "hold" : action), body);
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
      const client = await api(repo);
      let diff: DiffResponse;
      if (nodeRunId) diff = await client.get<DiffResponse>(API.diff(nodeRunId, scope));
      else if (runId && laneId) diff = await client.get<DiffResponse>(API.laneDiff(runId, laneId));
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
    guarded(async ({ repo, runId }) => json(compactReport(await (await api(repo)).get<RunReportResponse>(API.runReport(runId))))),
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
      const client = await api(repo);
      await client.post(API.cancelRun(runId));
      return json(compactRunSummary((await client.get<RunDetail>(API.run(runId))).run));
    }),
  );

  server.registerTool(
    "resume_run",
    {
      title: "Resume run",
      description: "Continues a paused run (e.g. after promptgraph restarted). Failed or interrupted steps still need node_action retry or skip.",
      inputSchema: { ...repoArg, runId: runIdArg },
      annotations: WRITE,
    },
    guarded(async ({ repo, runId }) => {
      const client = await api(repo);
      await client.post(API.resumeRun(runId));
      return json(compactRunDetail(await client.get<RunDetail>(API.run(runId))));
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
      await (await api(repo)).post(API.cleanupRun(runId));
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
      const { nodeRuns } = await (await api(repo)).get<PendingResponse>(API.pending);
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
      const info = await (await api(repo)).get<ApprovalInfoResponse>(API.approval(nodeRunId));
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

