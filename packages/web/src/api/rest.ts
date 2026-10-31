import {
  API,
  type ApiError,
  type AppSettings,
  type ApprovalInfoResponse,
  type ApprovalRequest,
  type DiffResponse,
  type GetGraphResponse,
  type GetRunResponse,
  type Graph,
  type ListCommandsResponse,
  type ListGraphsResponse,
  type ListRunsResponse,
  type NodeRunResponse,
  type PendingResponse,
  type ReopenResponse,
  type RepoInfoResponse,
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
    await request("GET", "/api/repo");
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

/** Typed REST client over the API paths in @promptgraph/shared (credentials: same-origin + dev Bearer token). */
export const api = {
  repo(): Promise<RepoInfoResponse> {
    return request("GET", API.repo);
  },
  getSettings(): Promise<AppSettings> {
    return request("GET", API.settings);
  },
  updateSettings(patch: UpdateAppSettingsRequest): Promise<AppSettings> {
    return request("PUT", API.settings, patch);
  },
  listGraphs(): Promise<ListGraphsResponse> {
    return request("GET", API.graphs);
  },
  getGraph(id: string): Promise<GetGraphResponse> {
    return request("GET", API.graph(id));
  },
  saveGraph(graph: Graph): Promise<SaveGraphResponse> {
    return request("PUT", API.graph(graph.id), graph);
  },
  async deleteGraph(id: string): Promise<void> {
    await request("DELETE", API.graph(id));
  },
  validateGraph(id: string, graph?: Graph): Promise<ValidationResult> {
    return request("POST", API.validate(id), graph ? { graph } : {});
  },
  startRun(graphId: string): Promise<StartRunResponse> {
    return request("POST", API.startRun(graphId), {});
  },
  listRuns(graphId?: string, limit?: number): Promise<ListRunsResponse> {
    const q = new URLSearchParams();
    if (graphId) q.set("graph", graphId);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    return request("GET", qs ? `${API.runs}?${qs}` : API.runs);
  },
  getRun(runId: string): Promise<GetRunResponse> {
    return request("GET", API.run(runId));
  },
  async cancelRun(runId: string): Promise<void> {
    await request("POST", API.cancelRun(runId), {});
  },
  async cleanupRun(runId: string): Promise<void> {
    await request("POST", API.cleanupRun(runId), {});
  },
  async resumeRun(runId: string): Promise<void> {
    await request("POST", API.resumeRun(runId), {});
  },
  pending(): Promise<PendingResponse> {
    return request("GET", API.pending);
  },
  nodeAction(nodeRunId: string, action: "done" | "retry" | "skip"): Promise<NodeRunResponse> {
    return request("POST", API.nodeRunAction(nodeRunId, action), {});
  },
  failNode(nodeRunId: string, reason?: string): Promise<NodeRunResponse> {
    return request("POST", API.nodeRunAction(nodeRunId, "fail"), reason ? { reason } : {});
  },
  holdNode(nodeRunId: string, hold: boolean): Promise<NodeRunResponse> {
    return request("POST", API.nodeRunAction(nodeRunId, "hold"), { hold });
  },
  approvalInfo(nodeRunId: string): Promise<ApprovalInfoResponse> {
    return request("GET", API.approval(nodeRunId));
  },
  submitApproval(nodeRunId: string, req: ApprovalRequest): Promise<NodeRunResponse> {
    return request("POST", API.approval(nodeRunId), req);
  },
  diff(nodeRunId: string): Promise<DiffResponse> {
    return request("GET", API.diff(nodeRunId));
  },
  reopen(nodeRunId: string): Promise<ReopenResponse> {
    return request("POST", API.reopen(nodeRunId), {});
  },
  async closePty(ptyId: string): Promise<void> {
    await request("DELETE", API.pty(ptyId));
  },
  commands(): Promise<ListCommandsResponse> {
    return request("GET", API.commands);
  },
};
