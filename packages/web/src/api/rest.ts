import {
  type ClaudeCheckResponse,
  type ClaudeSetupResponse,
  API,
  type ApiError,
  type AppSettings,
  type ApprovalInfoResponse,
  type ApprovalRequest,
  type DaemonInfoResponse,
  type DiffResponse,
  type DiffScope,
  type GetGraphResponse,
  type GetRunResponse,
  type Graph,
  type ListCommandsResponse,
  type ListGraphsResponse,
  type ListDirsResponse,
  type ListReposResponse,
  type ListRunsResponse,
  type NodeRunResponse,
  type PendingResponse,
  type ReopenResponse,
  type RepoInfoResponse,
  type RepoSummary,
  type RunReportResponse,
  type SaveGraphResponse,
  type StartRunResponse,
  type UpdateAppSettingsRequest,
  type ValidationResult,
} from "@promptgraph/shared";

/**
 * Typed REST client (DESIGN §12.1). The browser authenticates with its session cookie (same origin; the
 * vite dev server proxies to the daemon and adds nothing), so requests carry no credential of their own.
 * Daemon routes are in `daemonApi`, repository routes in `repoApi(repoId)`.
 */

/** Non-2xx response; `body` is the server's ApiError. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.error);
  }
}

const unauthorizedListeners = new Set<() => void>();

/**
 * Called when the daemon answers 401: the session is gone (token rotated, session revoked or expired, or no
 * cookie), DESIGN §13.5. Returns unsubscribe.
 */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Probes the session: false on 401, true when authorised, null when the daemon is unreachable. */
export async function sessionValid(): Promise<boolean | null> {
  try {
    await request("GET", API.daemon);
    return true;
  } catch (err) {
    return err instanceof ApiRequestError ? err.status !== 401 : null;
  }
}

/** Above this size a keepalive request is refused by browsers (64 KiB budget shared by the page). */
const KEEPALIVE_MAX_BYTES = 60_000;

async function request<T>(method: string, path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // The daemon requires JSON on cookie-authenticated writes (cross-origin requests then need a preflight).
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: payload,
    ...(opts.keepalive && payload && payload.length < KEEPALIVE_MAX_BYTES ? { keepalive: true } : {}),
  });
  const text = await res.text();
  const json: unknown = text ? safeJson(text) : undefined;
  if (res.status === 401) for (const l of unauthorizedListeners) l();
  if (!res.ok) {
    const err = isApiError(json) ? json : { error: text || `${res.status} ${res.statusText}` };
    throw new ApiRequestError(res.status, err);
  }
  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string";
}

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True for an ApiRequestError with this status (and code, when given). */
export function isApiStatus(err: unknown, status: number, code?: string): err is ApiRequestError {
  return err instanceof ApiRequestError && err.status === status && (code === undefined || err.body.code === code);
}

/** Daemon-wide routes. */
export const daemonApi = {
  daemon(): Promise<DaemonInfoResponse> {
    return request("GET", API.daemon);
  },
  repos(): Promise<ListReposResponse> {
    return request("GET", API.repos);
  },
  /** 422 path_not_absolute / not_a_git_repo / lane_worktree. */
  addRepo(path: string): Promise<RepoSummary> {
    return request("POST", API.repos, { path });
  },
  /** Subdirectories of `path` (default: the daemon user's home); 422 path_not_absolute, 404 not_a_directory, 403 permission_denied. */
  listDirs(path?: string, hidden = false): Promise<ListDirsResponse> {
    return request("GET", API.dirs(path, hidden));
  },
  /** 409 repo_active while it has a running run, unless `force`. */
  async removeRepo(repoId: string, force = false): Promise<void> {
    await request("DELETE", API.removeRepo(repoId, force));
  },
  getSettings(): Promise<AppSettings> {
    return request("GET", API.settings);
  },
  updateSettings(patch: UpdateAppSettingsRequest): Promise<AppSettings> {
    return request("PUT", API.settings, patch);
  },
};
export type DaemonApi = typeof daemonApi;

/** Routes of one repository (`/api/repos/:repoId/…`). */
export function repoApi(repoId: string) {
  const p = API.repo(repoId);
  return {
    repoId,
    info(): Promise<RepoInfoResponse> {
      return request("GET", p.info);
    },
    listGraphs(): Promise<ListGraphsResponse> {
      return request("GET", p.graphs);
    },
    getGraph(id: string): Promise<GetGraphResponse> {
      return request("GET", p.graph(id));
    },
    /** keepalive (when small enough), so a save flushed on `pagehide` survives the page. */
    saveGraph(graph: Graph): Promise<SaveGraphResponse> {
      return request("PUT", p.graph(graph.id), graph, { keepalive: true });
    },
    async deleteGraph(id: string): Promise<void> {
      await request("DELETE", p.graph(id));
    },
    validateGraph(id: string, graph?: Graph): Promise<ValidationResult> {
      return request("POST", p.validate(id), graph ? { graph } : {});
    },
    startRun(graphId: string): Promise<StartRunResponse> {
      return request("POST", p.startRun(graphId), {});
    },
    listRuns(graphId?: string, limit?: number): Promise<ListRunsResponse> {
      const q = new URLSearchParams();
      if (graphId) q.set("graph", graphId);
      if (limit) q.set("limit", String(limit));
      const qs = q.toString();
      return request("GET", qs ? `${p.runs}?${qs}` : p.runs);
    },
    getRun(runId: string): Promise<GetRunResponse> {
      return request("GET", p.run(runId));
    },
    async cancelRun(runId: string): Promise<void> {
      await request("POST", p.cancelRun(runId), {});
    },
    async cleanupRun(runId: string): Promise<void> {
      await request("POST", p.cleanupRun(runId), {});
    },
    async resumeRun(runId: string): Promise<void> {
      await request("POST", p.resumeRun(runId), {});
    },
    pending(): Promise<PendingResponse> {
      return request("GET", p.pending);
    },
    nodeAction(nodeRunId: string, action: "done" | "retry" | "skip"): Promise<NodeRunResponse> {
      return request("POST", p.nodeRunAction(nodeRunId, action), {});
    },
    failNode(nodeRunId: string, reason?: string): Promise<NodeRunResponse> {
      return request("POST", p.nodeRunAction(nodeRunId, "fail"), reason ? { reason } : {});
    },
    holdNode(nodeRunId: string, hold: boolean): Promise<NodeRunResponse> {
      return request("POST", p.nodeRunAction(nodeRunId, "hold"), { hold });
    },
    approvalInfo(nodeRunId: string): Promise<ApprovalInfoResponse> {
      return request("GET", p.approval(nodeRunId));
    },
    submitApproval(nodeRunId: string, req: ApprovalRequest): Promise<NodeRunResponse> {
      return request("POST", p.approval(nodeRunId), req);
    },
    diff(nodeRunId: string, scope: DiffScope = "lane"): Promise<DiffResponse> {
      return request("GET", p.diff(nodeRunId, scope));
    },
    laneDiff(runId: string, laneId: string): Promise<DiffResponse> {
      return request("GET", p.laneDiff(runId, laneId));
    },
    runReport(runId: string): Promise<RunReportResponse> {
      return request("GET", p.runReport(runId));
    },
    reopen(nodeRunId: string): Promise<ReopenResponse> {
      return request("POST", p.reopen(nodeRunId), {});
    },
    async closePty(ptyId: string): Promise<void> {
      await request("DELETE", p.pty(ptyId));
    },
    commands(): Promise<ListCommandsResponse> {
      return request("GET", p.commands);
    },
    claudeSetup(): Promise<ClaudeSetupResponse> {
      return request("GET", p.claudeSetup);
    },
    claudeCheck(): Promise<ClaudeCheckResponse> {
      return request("POST", p.claudeCheck, {});
    },
  };
}
export type RepoApi = ReturnType<typeof repoApi>;
