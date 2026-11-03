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
  type ListReposResponse,
  type ListRunsResponse,
  type NodeRunResponse,
  type PendingResponse,
  type ReopenResponse,
  type RepoApiPaths,
  type RepoInfoResponse,
  type RunReportResponse,
  type SaveGraphResponse,
  type StartRunResponse,
  type UpdateAppSettingsRequest,
  type ValidationResult,
} from "@promptgraph/shared";
import { devToken } from "./token";

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
 * Called when the server answers 401: the session token is no longer valid (each promptgraph start
 * makes a new one, so this tab belongs to a server that was restarted). Returns unsubscribe.
 */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Probes the session: false on 401, true when authorised, null when the server is unreachable. */
export async function sessionValid(): Promise<boolean | null> {
  try {
    await request("GET", API.daemon);
    return true;
  } catch (err) {
    return err instanceof ApiRequestError ? err.status !== 401 : null;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = devToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  // The server requires JSON on cookie-authenticated writes (cross-origin requests then need a preflight).
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
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

/** `/r/<repoId>` prefix of the page URL (DESIGN §13.2), or null. */
export function repoIdFromPath(pathname: string): string | null {
  const m = /^\/r\/([^/]+)/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

let currentRepo: Promise<string> | null = null;

/**
 * The repository this page shows (temporary, until the router lands): the `/r/<repoId>` prefix of the
 * URL, else the most recently opened registered repository. Resolved once per page; a failure is retried.
 */
export function currentRepoId(): Promise<string> {
  currentRepo ??= (async () => {
    const fromPath = typeof window === "undefined" ? null : repoIdFromPath(window.location.pathname);
    if (fromPath) return fromPath;
    const { repos } = await request<ListReposResponse>("GET", API.repos);
    const recent = [...repos].sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt))[0];
    if (!recent) throw new Error("No repository is registered: run `promptgraph` in a git repository.");
    return recent.id;
  })().catch((err: unknown) => {
    currentRepo = null;
    throw err;
  });
  return currentRepo;
}

/** Tests: forget the resolved repository. */
export function resetCurrentRepo(): void {
  currentRepo = null;
}

async function repoPaths(): Promise<RepoApiPaths> {
  return API.repo(await currentRepoId());
}

/** Typed REST client over the API paths in @promptgraph/shared (credentials: same-origin + dev Bearer token). */
export const api = {
  daemon(): Promise<DaemonInfoResponse> {
    return request("GET", API.daemon);
  },
  async repoInfo(): Promise<RepoInfoResponse> {
    return request("GET", (await repoPaths()).info);
  },
  getSettings(): Promise<AppSettings> {
    return request("GET", API.settings);
  },
  updateSettings(patch: UpdateAppSettingsRequest): Promise<AppSettings> {
    return request("PUT", API.settings, patch);
  },
  async listGraphs(): Promise<ListGraphsResponse> {
    return request("GET", (await repoPaths()).graphs);
  },
  async getGraph(id: string): Promise<GetGraphResponse> {
    return request("GET", (await repoPaths()).graph(id));
  },
  async saveGraph(graph: Graph): Promise<SaveGraphResponse> {
    return request("PUT", (await repoPaths()).graph(graph.id), graph);
  },
  async deleteGraph(id: string): Promise<void> {
    await request("DELETE", (await repoPaths()).graph(id));
  },
  async validateGraph(id: string, graph?: Graph): Promise<ValidationResult> {
    return request("POST", (await repoPaths()).validate(id), graph ? { graph } : {});
  },
  async startRun(graphId: string): Promise<StartRunResponse> {
    return request("POST", (await repoPaths()).startRun(graphId), {});
  },
  async listRuns(graphId?: string, limit?: number): Promise<ListRunsResponse> {
    const q = new URLSearchParams();
    if (graphId) q.set("graph", graphId);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    const { runs } = await repoPaths();
    return request("GET", qs ? `${runs}?${qs}` : runs);
  },
  async getRun(runId: string): Promise<GetRunResponse> {
    return request("GET", (await repoPaths()).run(runId));
  },
  async cancelRun(runId: string): Promise<void> {
    await request("POST", (await repoPaths()).cancelRun(runId), {});
  },
  async cleanupRun(runId: string): Promise<void> {
    await request("POST", (await repoPaths()).cleanupRun(runId), {});
  },
  async resumeRun(runId: string): Promise<void> {
    await request("POST", (await repoPaths()).resumeRun(runId), {});
  },
  async pending(): Promise<PendingResponse> {
    return request("GET", (await repoPaths()).pending);
  },
  async nodeAction(nodeRunId: string, action: "done" | "retry" | "skip"): Promise<NodeRunResponse> {
    return request("POST", (await repoPaths()).nodeRunAction(nodeRunId, action), {});
  },
  async failNode(nodeRunId: string, reason?: string): Promise<NodeRunResponse> {
    return request("POST", (await repoPaths()).nodeRunAction(nodeRunId, "fail"), reason ? { reason } : {});
  },
  async holdNode(nodeRunId: string, hold: boolean): Promise<NodeRunResponse> {
    return request("POST", (await repoPaths()).nodeRunAction(nodeRunId, "hold"), { hold });
  },
  async approvalInfo(nodeRunId: string): Promise<ApprovalInfoResponse> {
    return request("GET", (await repoPaths()).approval(nodeRunId));
  },
  async submitApproval(nodeRunId: string, req: ApprovalRequest): Promise<NodeRunResponse> {
    return request("POST", (await repoPaths()).approval(nodeRunId), req);
  },
  async diff(nodeRunId: string, scope: DiffScope = "lane"): Promise<DiffResponse> {
    return request("GET", (await repoPaths()).diff(nodeRunId, scope));
  },
  async laneDiff(runId: string, laneId: string): Promise<DiffResponse> {
    return request("GET", (await repoPaths()).laneDiff(runId, laneId));
  },
  async runReport(runId: string): Promise<RunReportResponse> {
    return request("GET", (await repoPaths()).runReport(runId));
  },
  async reopen(nodeRunId: string): Promise<ReopenResponse> {
    return request("POST", (await repoPaths()).reopen(nodeRunId), {});
  },
  async closePty(ptyId: string): Promise<void> {
    await request("DELETE", (await repoPaths()).pty(ptyId));
  },
  async commands(): Promise<ListCommandsResponse> {
    return request("GET", (await repoPaths()).commands);
  },
  async claudeSetup(): Promise<ClaudeSetupResponse> {
    return request("GET", (await repoPaths()).claudeSetup);
  },
  async checkClaudeSetup(): Promise<ClaudeCheckResponse> {
    return request("POST", (await repoPaths()).claudeCheck, {});
  },
};
