import { LINEAR_STATE_TYPES, LinearIssueSchema, type LinearIssue, type LinearStateType, type LinearWorkflowState } from "@promptgraph/shared";
import { z } from "zod";
import { errorMessage } from "../util/text.js";

/**
 * Minimal Linear GraphQL client (DESIGN §24). Personal API keys go in the `Authorization` header as they are (no
 * "Bearer"). Errors never carry the key: messages come from the network error or Linear's own error text.
 */

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 10_000;
const PAGE = 25;

/** The subset of `fetch` the client uses (tests inject a fake). */
export type LinearFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** `unauthorized`: Linear rejected the key. `unavailable`: network error, timeout or an unexpected answer. */
export class LinearApiError extends Error {
  constructor(
    readonly kind: "unauthorized" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** An issue with what a `linear` node needs to propose updates (§24.5): its state and its team's states. */
export interface LinearIssueContext {
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  /** Markdown description, "" when none. */
  description: string;
  currentState: LinearWorkflowState | null;
  /** The team's workflow states, in workflow order. */
  states: LinearWorkflowState[];
}

const WorkflowStateNodeSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string(), position: z.number().optional() });
const IssueContextNodeSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string().nullish(),
  state: WorkflowStateNodeSchema.nullish(),
  team: z.object({ states: z.object({ nodes: z.array(WorkflowStateNodeSchema) }) }).nullish(),
});

const plainState = ({ id, name, type, color }: z.infer<typeof WorkflowStateNodeSchema>): LinearWorkflowState => ({ id, name, type, color });

export interface LinearViewer {
  viewer: { name: string; email: string | null };
  workspace: { name: string; urlKey: string };
}

const ISSUE_FIELDS = "id identifier title url branchName state { name type color } team { key } assignee { name }";

const RawIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  branchName: z.string().nullish(),
  state: z.object({ name: z.string(), type: z.string(), color: z.string() }).nullish(),
  team: z.object({ key: z.string() }).nullish(),
  assignee: z.object({ name: z.string() }).nullish(),
});

const GraphQlErrorSchema = z.object({
  message: z.string().optional(),
  extensions: z.object({ type: z.string().optional(), code: z.string().optional() }).loose().optional(),
});
const EnvelopeSchema = z.object({ data: z.unknown().optional(), errors: z.array(GraphQlErrorSchema).optional() });

function isAuthError(e: z.infer<typeof GraphQlErrorSchema>): boolean {
  const kind = `${e.extensions?.code ?? ""} ${e.extensions?.type ?? ""}`.toLowerCase();
  return kind.includes("authentication") || kind.includes("forbidden");
}

/** Linear's issue node → LinearIssue; null when it does not fit (e.g. a non-https URL). */
function toIssue(raw: unknown): LinearIssue | null {
  const parsed = RawIssueSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const issue = LinearIssueSchema.safeParse({
    provider: "linear",
    id: r.id,
    identifier: r.identifier,
    title: r.title,
    url: r.url,
    ...(r.branchName ? { branchName: r.branchName } : {}),
    state: r.state ?? null,
    teamKey: r.team?.key ?? null,
    assignee: r.assignee?.name ?? null,
  });
  return issue.success ? issue.data : null;
}

function issueList(nodes: unknown): LinearIssue[] {
  return Array.isArray(nodes) ? nodes.map(toIssue).filter((i): i is LinearIssue => i !== null) : [];
}

export class LinearClient {
  private readonly fetch: LinearFetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(opts: { fetch?: LinearFetch; endpoint?: string; timeoutMs?: number } = {}) {
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as LinearFetch);
    this.endpoint = opts.endpoint ?? LINEAR_GRAPHQL_URL;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * One GraphQL request. @returns `data` and the non-auth errors (a lookup of a missing issue answers with an error
   * and `data.issue: null`). @throws LinearApiError
   */
  private async request(key: string, query: string, variables: Record<string, unknown> = {}): Promise<{ data: unknown; errors: string[] }> {
    let res: Awaited<ReturnType<LinearFetch>>;
    try {
      res = await this.fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new LinearApiError("unavailable", `Could not reach Linear: ${errorMessage(err)}`);
    }
    if (res.status === 401 || res.status === 403) throw new LinearApiError("unauthorized", "Linear rejected the API key");
    let body: z.infer<typeof EnvelopeSchema>;
    try {
      body = EnvelopeSchema.parse(await res.json());
    } catch {
      throw new LinearApiError("unavailable", `Unexpected answer from Linear (HTTP ${res.status})`);
    }
    const errors = body.errors ?? [];
    if (errors.some(isAuthError)) throw new LinearApiError("unauthorized", "Linear rejected the API key");
    const messages = errors.map((e) => e.message ?? "Unknown Linear error");
    if (!res.ok || body.data === undefined || body.data === null) {
      throw new LinearApiError("unavailable", messages[0] ?? `Unexpected answer from Linear (HTTP ${res.status})`);
    }
    return { data: body.data, errors: messages };
  }

  /** The key's user and workspace: checks a key. */
  async viewer(key: string): Promise<LinearViewer> {
    const { data } = await this.request(key, "query { viewer { name email } organization { name urlKey } }");
    const parsed = z
      .object({
        viewer: z.object({ name: z.string(), email: z.string().nullish() }),
        organization: z.object({ name: z.string(), urlKey: z.string() }),
      })
      .safeParse(data);
    if (!parsed.success) throw new LinearApiError("unavailable", "Unexpected answer from Linear");
    return { viewer: { name: parsed.data.viewer.name, email: parsed.data.viewer.email ?? null }, workspace: parsed.data.organization };
  }

  /** The viewer's issues in one of `states`, most recently updated first. */
  async assignedIssues(key: string, states: readonly LinearStateType[] = LINEAR_STATE_TYPES): Promise<LinearIssue[]> {
    const { data } = await this.request(
      key,
      `query($first: Int!, $states: [String!]!) { viewer { assignedIssues(first: $first, orderBy: updatedAt, filter: { state: { type: { in: $states } } }) { nodes { ${ISSUE_FIELDS} } } } }`,
      { first: PAGE, states },
    );
    return issueList((data as { viewer?: { assignedIssues?: { nodes?: unknown } } }).viewer?.assignedIssues?.nodes);
  }

  /** The workspace's issues in one of `states`, most recently updated first. */
  async recentIssues(key: string, states: readonly LinearStateType[] = LINEAR_STATE_TYPES): Promise<LinearIssue[]> {
    const { data } = await this.request(
      key,
      `query($first: Int!, $states: [String!]!) { issues(first: $first, orderBy: updatedAt, filter: { state: { type: { in: $states } } }) { nodes { ${ISSUE_FIELDS} } } }`,
      { first: PAGE, states },
    );
    return issueList((data as { issues?: { nodes?: unknown } }).issues?.nodes);
  }

  /** Full-text search over the workspace's issues in one of `states`; `mine`: only those assigned to the viewer. */
  async searchIssues(key: string, term: string, states: readonly LinearStateType[] = LINEAR_STATE_TYPES, mine = false): Promise<LinearIssue[]> {
    const filter = mine ? "{ state: { type: { in: $states } }, assignee: { isMe: { eq: true } } }" : "{ state: { type: { in: $states } } }";
    const { data } = await this.request(
      key,
      `query($term: String!, $first: Int!, $states: [String!]!) { searchIssues(term: $term, first: $first, filter: ${filter}) { nodes { ${ISSUE_FIELDS} } } }`,
      { term, first: PAGE, states },
    );
    return issueList((data as { searchIssues?: { nodes?: unknown } }).searchIssues?.nodes);
  }

  /** Issues by Linear id (archived ones included); ids Linear does not know are missing from the answer. */
  async issuesById(key: string, ids: readonly string[]): Promise<LinearIssue[]> {
    const { data } = await this.request(
      key,
      `query($ids: [ID!]!, $first: Int!) { issues(first: $first, includeArchived: true, filter: { id: { in: $ids } }) { nodes { ${ISSUE_FIELDS} } } }`,
      { ids, first: ids.length },
    );
    return issueList((data as { issues?: { nodes?: unknown } }).issues?.nodes);
  }

  /** Issues by id with their state and their team's workflow states (§24.5); unknown ids are missing. */
  async issueContext(key: string, ids: readonly string[]): Promise<LinearIssueContext[]> {
    const { data } = await this.request(
      key,
      `query($ids: [ID!]!, $first: Int!) { issues(first: $first, includeArchived: true, filter: { id: { in: $ids } }) { nodes { id identifier title url description state { id name type color } team { states(first: 100) { nodes { id name type color position } } } } } }`,
      { ids, first: ids.length },
    );
    const nodes = (data as { issues?: { nodes?: unknown } }).issues?.nodes;
    if (!Array.isArray(nodes)) return [];
    return nodes.flatMap((raw): LinearIssueContext[] => {
      const parsed = IssueContextNodeSchema.safeParse(raw);
      if (!parsed.success) return [];
      const n = parsed.data;
      const states = [...(n.team?.states.nodes ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(plainState);
      return [{ issueId: n.id, identifier: n.identifier, title: n.title, url: n.url, description: n.description ?? "", currentState: n.state ? plainState(n.state) : null, states }];
    });
  }

  /** Adds a Markdown comment to an issue, as the key's user. @throws LinearApiError */
  async createComment(key: string, issueId: string, body: string): Promise<void> {
    const { data } = await this.request(key, "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }", { issueId, body });
    if ((data as { commentCreate?: { success?: boolean } }).commentCreate?.success !== true) throw new LinearApiError("unavailable", "Linear did not create the comment");
  }

  /** Moves an issue to a workflow state. @throws LinearApiError */
  async setIssueState(key: string, issueId: string, stateId: string): Promise<void> {
    const { data } = await this.request(key, "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }", { id: issueId, stateId });
    if ((data as { issueUpdate?: { success?: boolean } }).issueUpdate?.success !== true) throw new LinearApiError("unavailable", "Linear did not update the issue");
  }

  /** One issue by identifier ("ENG-123") or id; null when Linear has none. */
  async issue(key: string, idOrIdentifier: string): Promise<LinearIssue | null> {
    let data: unknown;
    try {
      ({ data } = await this.request(key, `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: idOrIdentifier }));
    } catch (err) {
      // A missing issue is an error with `data: null` for some identifiers.
      if (err instanceof LinearApiError && err.kind === "unavailable" && /not found/i.test(err.message)) return null;
      throw err;
    }
    return toIssue((data as { issue?: unknown }).issue ?? null);
  }
}
