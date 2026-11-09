import { z } from "zod";

/**
 * Linear integration (DESIGN §24): a graph can be linked to a Linear issue when it is created. The daemon talks to
 * Linear's GraphQL API with the user's personal API key, which never leaves the daemon (it is not returned by any
 * route, logged, or made available to Claude PTYs).
 */

/** A Linear issue identifier: team key, dash, number ("ENG-123"). */
export const LINEAR_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,15}-[1-9][0-9]{0,8}$/;

/** The issue a graph is linked to, stored in the graph file (§6). Only what the UI and the runners need. */
export const GraphIssueSchema = z.object({
  provider: z.literal("linear"),
  /** Linear's issue id (UUID). */
  id: z.string().min(1),
  identifier: z.string().regex(LINEAR_IDENTIFIER_PATTERN, "a Linear identifier such as ENG-123"),
  title: z.string(),
  url: z.url({ protocol: /^https$/ }),
  /** Linear's suggested git branch name (`gitBranchName`); used as the graph's branch prefix at creation. */
  branchName: z.string().optional(),
});
export type GraphIssue = z.infer<typeof GraphIssueSchema>;

/** Most issues one graph links. */
export const MAX_GRAPH_ISSUES = 20;

/** `Graph.issues`: at most MAX_GRAPH_ISSUES, each linked once. */
export const GraphIssuesSchema = z
  .array(GraphIssueSchema)
  .max(MAX_GRAPH_ISSUES)
  .refine((issues) => new Set(issues.map((i) => i.id)).size === issues.length, "each issue is linked once");

/** One search result of GET /api/linear/issues: the linkable part plus what the picker shows. */
export const LinearIssueSchema = GraphIssueSchema.extend({
  state: z.object({ name: z.string(), type: z.string(), color: z.string() }).nullable(),
  teamKey: z.string().nullable(),
  /** Display name of the assignee; null when unassigned (absent in older answers). */
  assignee: z.string().nullable().optional(),
});
export type LinearIssue = z.infer<typeof LinearIssueSchema>;

/** GET /api/linear → whether a key is saved and whom it belongs to. Never contains the key. */
export const LinearStatusResponseSchema = z.object({
  connected: z.boolean(),
  /** The key's user and workspace, when Linear answered. */
  viewer: z.object({ name: z.string(), email: z.string().nullable() }).nullable(),
  workspace: z.object({ name: z.string(), urlKey: z.string() }).nullable(),
  /** Why the saved key could not be checked (`linear_key_invalid`, `linear_unavailable`); null otherwise. */
  error: z.string().nullable(),
});
export type LinearStatusResponse = z.infer<typeof LinearStatusResponseSchema>;

/** PUT /api/linear/key body. The key is checked against Linear before it is saved (422 linear_key_invalid). */
export const SetLinearKeyRequestSchema = z.object({ apiKey: z.string().trim().min(1).max(512) });
export type SetLinearKeyRequest = z.infer<typeof SetLinearKeyRequestSchema>;

/** Linear's workflow state types, in workflow order. */
export const LINEAR_STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
export const LinearStateTypeSchema = z.enum(LINEAR_STATE_TYPES);
export type LinearStateType = z.infer<typeof LinearStateTypeSchema>;

/** State types the picker searches by default: work that is not done or canceled. */
export const LINEAR_OPEN_STATE_TYPES: readonly LinearStateType[] = ["triage", "backlog", "unstarted", "started"];

/** The picker's state filter (§24.2): one toggle per group of state types. */
export const LINEAR_STATE_GROUPS = [
  { id: "backlog", label: "Backlog", types: ["triage", "backlog"] },
  { id: "todo", label: "Todo", types: ["unstarted"] },
  { id: "started", label: "In progress", types: ["started"] },
  { id: "done", label: "Done", types: ["completed"] },
  { id: "canceled", label: "Canceled", types: ["canceled"] },
] as const satisfies readonly { id: string; label: string; types: readonly LinearStateType[] }[];
export type LinearStateGroupId = (typeof LINEAR_STATE_GROUPS)[number]["id"];
export const DEFAULT_LINEAR_STATE_GROUPS: readonly LinearStateGroupId[] = ["backlog", "todo", "started"];

/** State types of the selected groups, in workflow order (no group selected = every type). */
export function stateTypesOfGroups(groups: readonly string[]): LinearStateType[] {
  const picked = new Set<LinearStateType>(LINEAR_STATE_GROUPS.filter((g) => groups.includes(g.id)).flatMap((g) => g.types));
  return picked.size ? LINEAR_STATE_TYPES.filter((t) => picked.has(t)) : [...LINEAR_STATE_TYPES];
}

/** Whose issues the search covers: the viewer's assigned ones, or the whole workspace. */
export const LinearIssueScopeSchema = z.enum(["mine", "all"]);
export type LinearIssueScope = z.infer<typeof LinearIssueScopeSchema>;

/**
 * GET /api/linear/issues?q=&states=&scope= — `q` empty: a list (most recently updated first); an identifier or issue
 * URL: that issue (whatever its state and assignee: it was named); anything else: a full-text search. `states`
 * (comma-separated state types) filters the list and the search; absent = LINEAR_OPEN_STATE_TYPES. `scope`: `mine`
 * (assigned to the viewer) or `all` (the workspace); absent = `mine` for the list and `all` for a search.
 */
export const LinearIssuesQuerySchema = z.object({
  scope: LinearIssueScopeSchema.optional(),
  q: z.string().max(200).default(""),
  states: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return [...LINEAR_OPEN_STATE_TYPES];
      const types = [...new Set(v.split(",").map((t) => t.trim()))];
      const bad = types.filter((t) => !LinearStateTypeSchema.safeParse(t).success);
      if (bad.length) {
        ctx.addIssue({ code: "custom", message: `Unknown Linear state type: ${bad.join(", ")}` });
        return z.NEVER;
      }
      return types as LinearStateType[];
    }),
});
export type LinearIssuesQuery = z.infer<typeof LinearIssuesQuerySchema>;
export const LinearIssuesResponseSchema = z.object({ issues: z.array(LinearIssueSchema) });
export type LinearIssuesResponse = z.infer<typeof LinearIssuesResponseSchema>;

/** Most issues one GET /api/linear/issue-states asks Linear for. */
export const LINEAR_MAX_STATE_IDS = 50;

/**
 * GET /api/linear/issue-states?ids= — the current state (and title) of linked issues, by Linear id (comma-separated,
 * at most LINEAR_MAX_STATE_IDS): the diagram's header and the overview's cards (§24.3). Issues Linear does not know
 * (deleted, another workspace) are missing from the answer. Cached by the daemon for LINEAR_STATE_TTL_MS.
 */
export const LinearIssueStatesQuerySchema = z.object({
  ids: z
    .string()
    .transform((v) => [...new Set(v.split(",").map((id) => id.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(64).regex(/^[A-Za-z0-9-]+$/, "a Linear issue id")).min(1).max(LINEAR_MAX_STATE_IDS)),
});
export type LinearIssueStatesQuery = z.infer<typeof LinearIssueStatesQuerySchema>;
export const LinearIssueStatesResponseSchema = z.object({ issues: z.array(LinearIssueSchema) });
export type LinearIssueStatesResponse = z.infer<typeof LinearIssueStatesResponseSchema>;
export const LINEAR_STATE_TTL_MS = 60_000;

// --- linear nodes: progress updates (§24.5) ---------------------------------

/** Instructions of a `linear` node when its config has none (DESIGN §24.5). */
export const DEFAULT_LINEAR_UPDATE_PROMPT =
  "Update the progress of the Linear issues linked to this graph, based on the work done so far in this run. " +
  "For each issue the work relates to, write a short progress comment for the team: what was done, what is left, and the " +
  "pull request if there is one. Change an issue's state only when the work clearly moves it (for example to In Progress " +
  "or In Review), choosing from its allowed states. Leave issues the work does not touch unchanged.";

export const LinearWorkflowStateSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string() });
export type LinearWorkflowState = z.infer<typeof LinearWorkflowStateSchema>;

/** One issue as a `linear` node proposes to update it (shown, and editable, in the approval dialog). */
export const LinearUpdateProposalSchema = z.object({
  issueId: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  currentState: LinearWorkflowStateSchema.nullable(),
  /** Workflow states of the issue's team, in workflow order: what the state may change to. */
  states: z.array(LinearWorkflowStateSchema),
  /** Progress comment (Markdown); "" = none. */
  comment: z.string(),
  /** New state; null = keep the current one. */
  stateId: z.string().nullable(),
});
export type LinearUpdateProposal = z.infer<typeof LinearUpdateProposalSchema>;

/** What applying one update did. */
export const LinearUpdateResultSchema = z.object({
  identifier: z.string(),
  commented: z.boolean(),
  /** Name of the state the issue was moved to; null when it was not moved. */
  movedTo: z.string().nullable(),
  error: z.string().nullable(),
});
export type LinearUpdateResult = z.infer<typeof LinearUpdateResultSchema>;

/** NodeRunOutput.linear of a `linear` node: the proposal, then what was applied. */
export const LinearUpdateOutputSchema = z.object({
  proposals: z.array(LinearUpdateProposalSchema),
  results: z.array(LinearUpdateResultSchema).optional(),
});
export type LinearUpdateOutput = z.infer<typeof LinearUpdateOutputSchema>;

/** ApprovalRequest.linearUpdates: the (edited) updates to apply; proposals left out are not applied. */
export const LinearUpdateDecisionSchema = z.object({
  issueId: z.string(),
  comment: z.string().max(20_000),
  stateId: z.string().nullable(),
});
export type LinearUpdateDecision = z.infer<typeof LinearUpdateDecisionSchema>;

/** --json-schema of the headless call that proposes the updates; `state` is a state name or "" (keep). */
export const LinearUpdateSuggestionSchema = z.object({
  updates: z.array(z.object({ identifier: z.string(), comment: z.string(), state: z.string() })),
});
export type LinearUpdateSuggestion = z.infer<typeof LinearUpdateSuggestionSchema>;
export const LINEAR_UPDATE_JSON_SCHEMA = {
  type: "object",
  properties: {
    updates: {
      type: "array",
      items: {
        type: "object",
        properties: { identifier: { type: "string" }, comment: { type: "string" }, state: { type: "string" } },
        required: ["identifier", "comment", "state"],
        additionalProperties: false,
      },
    },
  },
  required: ["updates"],
  additionalProperties: false,
} as const;

/** Error codes of the /api/linear routes. */
export const LINEAR_ERROR = {
  /** No key saved (409). */
  notConnected: "linear_not_connected",
  /** Linear rejected the key (422 on PUT, 502 elsewhere). */
  keyInvalid: "linear_key_invalid",
  /** Network error, timeout or an unexpected answer from Linear (502). */
  unavailable: "linear_unavailable",
} as const;

const ISSUE_URL = /^https:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9_]{0,15}-[1-9][0-9]{0,8})(?:[/?#]\S*)?$/;

/**
 * The identifier a picker input names directly: "ENG-123" (any case) or a linear.app issue URL. Null for free text,
 * which is searched instead.
 */
export function parseIssueReference(text: string): string | null {
  const t = text.trim();
  if (LINEAR_IDENTIFIER_PATTERN.test(t)) return t.toUpperCase();
  const m = ISSUE_URL.exec(t);
  return m ? m[1]!.toUpperCase() : null;
}

/** Default name of a graph created for issues: the first one's (the others are listed with the graph). */
export function graphNameForIssue(issue: Pick<GraphIssue, "identifier" | "title">): string {
  const title = issue.title.trim();
  return title ? `${issue.identifier} ${title}` : issue.identifier;
}

const BRANCH_PREFIX_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/** Whether `prefix` is a branch prefix the validator accepts (§6, GraphSettings.branchPrefix). */
export function isValidBranchPrefix(prefix: string): boolean {
  const p = prefix.trim();
  return BRANCH_PREFIX_PATTERN.test(p) && !/\.\.|\.lock(\/|$)|\.(\/|$)/.test(p);
}

/**
 * Branch prefix of a graph created for an issue: Linear's own branch name when it is valid (Linear links branches
 * and pull requests that carry the identifier to the issue), else `pg/<identifier>`.
 */
export function branchPrefixForIssue(issue: Pick<GraphIssue, "identifier" | "branchName">): string {
  const linear = issue.branchName?.trim();
  if (linear && isValidBranchPrefix(linear)) return linear;
  return `pg/${issue.identifier.toLowerCase()}`;
}

/**
 * A pull request proposal that names the linked issues (§6.1 `pr`): the identifiers it does not mention yet are
 * appended to the title as " (ENG-1, ENG-2)" and to the body as one "Fixes ENG-1" line each. Linear links the PR to
 * every issue and completes them when the PR merges. The user sees and can edit both in the approval dialog.
 */
export function withIssueReferences(proposal: { title: string; body: string }, issues: readonly Pick<GraphIssue, "identifier">[] | undefined): { title: string; body: string } {
  if (!issues?.length) return proposal;
  const mentions = (s: string, id: string) => new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[-]/g, "\\-")}($|[^0-9])`, "i").test(s);
  const ids = [...new Set(issues.map((i) => i.identifier))];
  const forTitle = ids.filter((id) => !mentions(proposal.title, id));
  const forBody = ids.filter((id) => !mentions(proposal.body, id));
  const title = forTitle.length ? `${proposal.title.trimEnd()} (${forTitle.join(", ")})` : proposal.title;
  const fixes = forBody.map((id) => `Fixes ${id}`).join("\n");
  const body = forBody.length ? `${proposal.body.trimEnd()}${proposal.body.trim() ? "\n\n" : ""}${fixes}` : proposal.body;
  return { title, body };
}
