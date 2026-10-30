import type {
  ApiError,
  AppSettings,
  ApprovalInfoResponse,
  ApprovalRequest,
  DiffResponse,
  GetGraphResponse,
  GetRunResponse,
  Graph,
  ListCommandsResponse,
  ListGraphsResponse,
  ListRunsResponse,
  NodeRunResponse,
  PendingResponse,
  ReopenResponse,
  RepoInfoResponse,
  SaveGraphResponse,
  StartRunResponse,
  UpdateAppSettingsRequest,
  ValidationResult,
} from "@promptgraph/shared";

/** Non-2xx response; `body` is the server's ApiError. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.error);
  }
}

/** Typed REST client over the API paths in @promptgraph/shared (credentials: same-origin + dev Bearer token). */
export const api = {
  repo(): Promise<RepoInfoResponse> {
    throw new Error("not implemented");
  },
  getSettings(): Promise<AppSettings> {
    throw new Error("not implemented");
  },
  updateSettings(patch: UpdateAppSettingsRequest): Promise<AppSettings> {
    throw new Error("not implemented");
  },
  listGraphs(): Promise<ListGraphsResponse> {
    throw new Error("not implemented");
  },
  getGraph(id: string): Promise<GetGraphResponse> {
    throw new Error("not implemented");
  },
  saveGraph(graph: Graph): Promise<SaveGraphResponse> {
    throw new Error("not implemented");
  },
  deleteGraph(id: string): Promise<void> {
    throw new Error("not implemented");
  },
  validateGraph(id: string, graph?: Graph): Promise<ValidationResult> {
    throw new Error("not implemented");
  },
  startRun(graphId: string): Promise<StartRunResponse> {
    throw new Error("not implemented");
  },
  listRuns(graphId?: string, limit?: number): Promise<ListRunsResponse> {
    throw new Error("not implemented");
  },
  getRun(runId: string): Promise<GetRunResponse> {
    throw new Error("not implemented");
  },
  cancelRun(runId: string): Promise<void> {
    throw new Error("not implemented");
  },
  cleanupRun(runId: string): Promise<void> {
    throw new Error("not implemented");
  },
  pending(): Promise<PendingResponse> {
    throw new Error("not implemented");
  },
  nodeAction(nodeRunId: string, action: "done" | "retry" | "skip"): Promise<NodeRunResponse> {
    throw new Error("not implemented");
  },
  failNode(nodeRunId: string, reason?: string): Promise<NodeRunResponse> {
    throw new Error("not implemented");
  },
  holdNode(nodeRunId: string, hold: boolean): Promise<NodeRunResponse> {
    throw new Error("not implemented");
  },
  approvalInfo(nodeRunId: string): Promise<ApprovalInfoResponse> {
    throw new Error("not implemented");
  },
  submitApproval(nodeRunId: string, req: ApprovalRequest): Promise<NodeRunResponse> {
    throw new Error("not implemented");
  },
  diff(nodeRunId: string): Promise<DiffResponse> {
    throw new Error("not implemented");
  },
  reopen(nodeRunId: string): Promise<ReopenResponse> {
    throw new Error("not implemented");
  },
  commands(): Promise<ListCommandsResponse> {
    throw new Error("not implemented");
  },
};
