import {
  LINEAR_ERROR,
  LINEAR_OPEN_STATE_TYPES,
  LINEAR_STATE_TTL_MS,
  parseIssueReference,
  type LinearIssue,
  type LinearIssueScope,
  type LinearStateType,
  type LinearStatusResponse,
} from "@promptgraph/shared";
import type { PgPaths } from "../config/paths.js";
import { LinearApiError, LinearClient, type LinearIssueContext } from "./client.js";
import { deleteLinearKey, readLinearKey, writeLinearKey } from "./key-store.js";

/** No key saved: the /api/linear routes answer 409 linear_not_connected. */
export class LinearNotConnectedError extends Error {
  constructor() {
    super("Linear is not connected: add a personal API key in Settings → Linear");
  }
}

const DISCONNECTED: LinearStatusResponse = { connected: false, viewer: null, workspace: null, error: null };

/**
 * The daemon's Linear connection (DESIGN §24): the saved key (`linear-key`, read on every call so a key replaced
 * by hand is picked up) and the status of the last check, cached per key. A transient failure (`linear_unavailable`)
 * is not cached, so the next status call checks again.
 */
export class LinearService {
  private cached: { key: string; status: LinearStatusResponse } | null = null;
  /** Linked issues' current state by id (null: Linear does not know it), for LINEAR_STATE_TTL_MS; dropped with the key. */
  private states = new Map<string, { key: string; issue: LinearIssue | null; at: number }>();

  constructor(
    private readonly paths: PgPaths,
    private readonly client: LinearClient = new LinearClient(),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The current state of linked issues (§24.3). Fresh cache entries are answered without asking Linear; the rest is
   * one `issues(filter: { id: { in } })` query. @throws LinearNotConnectedError, LinearApiError
   */
  async issuesById(ids: readonly string[]): Promise<LinearIssue[]> {
    const key = readLinearKey(this.paths);
    if (!key) throw new LinearNotConnectedError();
    const now = this.now();
    const fresh = (id: string) => {
      const e = this.states.get(id);
      return e && e.key === key && now - e.at < LINEAR_STATE_TTL_MS ? e : null;
    };
    const missing = ids.filter((id) => !fresh(id));
    if (missing.length) {
      const found = new Map((await this.client.issuesById(key, missing)).map((i) => [i.id, i]));
      for (const id of missing) this.states.set(id, { key, issue: found.get(id) ?? null, at: now });
    }
    return ids.map((id) => this.states.get(id)?.issue).filter((i): i is LinearIssue => !!i);
  }

  async status(): Promise<LinearStatusResponse> {
    const key = readLinearKey(this.paths);
    if (!key) return DISCONNECTED;
    if (this.cached?.key === key) return this.cached.status;
    let status: LinearStatusResponse;
    try {
      status = { connected: true, ...(await this.client.viewer(key)), error: null };
    } catch (err) {
      if (!(err instanceof LinearApiError)) throw err;
      status = { connected: true, viewer: null, workspace: null, error: err.kind === "unauthorized" ? LINEAR_ERROR.keyInvalid : LINEAR_ERROR.unavailable };
      if (err.kind === "unavailable") return status;
    }
    this.cached = { key, status };
    return status;
  }

  /** Checks the key with Linear, then saves it. @throws LinearApiError (nothing is saved) */
  async setKey(apiKey: string): Promise<LinearStatusResponse> {
    const key = apiKey.trim();
    const viewer = await this.client.viewer(key);
    writeLinearKey(this.paths, key);
    const status: LinearStatusResponse = { connected: true, ...viewer, error: null };
    this.cached = { key, status };
    return status;
  }

  /** §24.5: the linked issues with their states and their teams' states. @throws LinearNotConnectedError, LinearApiError */
  async issueContext(ids: readonly string[]): Promise<LinearIssueContext[]> {
    return ids.length ? this.client.issueContext(this.requireKey(), ids) : [];
  }

  /** §24.5, after approval only: a progress comment. @throws LinearNotConnectedError, LinearApiError */
  async comment(issueId: string, body: string): Promise<void> {
    await this.client.createComment(this.requireKey(), issueId, body);
  }

  /** §24.5, after approval only: a state change; the cached state of the issue is dropped. */
  async setState(issueId: string, stateId: string): Promise<void> {
    await this.client.setIssueState(this.requireKey(), issueId, stateId);
    this.states.delete(issueId);
  }

  private requireKey(): string {
    const key = readLinearKey(this.paths);
    if (!key) throw new LinearNotConnectedError();
    return key;
  }

  clearKey(): LinearStatusResponse {
    deleteLinearKey(this.paths);
    this.cached = null;
    this.states.clear();
    return DISCONNECTED;
  }

  /**
   * Issues for the picker: an empty query lists the issues in `states` (the viewer's assigned ones, or the workspace's
   * with `scope: "all"`), an identifier or issue URL looks that issue up (whatever its state: the user named it),
   * anything else is a full-text search in `states` (only the viewer's with `scope: "mine"`).
   * @throws LinearNotConnectedError, LinearApiError
   */
  async issues(query: string, states: readonly LinearStateType[] = LINEAR_OPEN_STATE_TYPES, scope?: LinearIssueScope): Promise<LinearIssue[]> {
    const key = readLinearKey(this.paths);
    if (!key) throw new LinearNotConnectedError();
    const q = query.trim();
    if (!q) return (scope ?? "mine") === "mine" ? this.client.assignedIssues(key, states) : this.client.recentIssues(key, states);
    const ref = parseIssueReference(q);
    if (ref) {
      const issue = await this.client.issue(key, ref);
      return issue ? [issue] : [];
    }
    return this.client.searchIssues(key, q, states, scope === "mine");
  }
}
