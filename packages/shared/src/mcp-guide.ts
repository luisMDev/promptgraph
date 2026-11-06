import { z } from "zod";

/**
 * Guide to the Claude Code integration (DESIGN §19.5): what the plugin's skills do and which MCP tools
 * exist, shown by the web UI's setup wizard. The server test suite checks that the tool names here are
 * exactly the registered MCP tools and that every skill has a SKILL.md, so this catalog cannot drift.
 */

export const McpSkillInfoSchema = z.object({
  /** Directory name under plugins/promptgraph/skills and the skill name in its frontmatter. */
  name: z.string(),
  title: z.string(),
  summary: z.string(),
  examples: z.array(z.string()),
});
export type McpSkillInfo = z.infer<typeof McpSkillInfoSchema>;

export const McpToolGroupSchema = z.object({
  title: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      summary: z.string(),
      /** Claude asks the user before calling it (destructive or stops work). */
      confirmFirst: z.boolean().optional(),
    }),
  ),
});
export type McpToolGroup = z.infer<typeof McpToolGroupSchema>;

export const MCP_SKILLS: readonly McpSkillInfo[] = [
  {
    name: "design-graph",
    title: "Design a graph",
    summary:
      "Turns a task into steps, parallel lanes, merges, checks and loops, then saves it under .promptgraph/graphs. Asks before saving when the work is unclear.",
    examples: [
      "Design a promptgraph graph that implements TODO.md with a test-fix loop and opens a draft PR.",
      "Split this refactor into two parallel steps and a merge, and save it as refactor-api.",
    ],
  },
  {
    name: "run-graph",
    title: "Run and supervise",
    summary:
      "Validates and starts a run, waits for it, handles steps that need input or approval, and reports the result. It never approves for you.",
    examples: ["Run implement-until-green and tell me when it needs me.", "Why is the run stuck? Check the release graph."],
  },
  {
    name: "review-run",
    title: "Review a run",
    summary: "Explains what a run changed, why it stopped or waited, and how to make the graph more reliable.",
    examples: ["Summarise the last run.", "Why did the tests step fail, and how should I change the graph?"],
  },
];

export const MCP_TOOL_GROUPS: readonly McpToolGroup[] = [
  {
    title: "Server",
    tools: [
      { name: "server_status", summary: "Whether the daemon runs (pid, version, port) and this repository is registered, with its counters." },
      { name: "start_server", summary: "Starts the daemon if needed (it keeps running; promptgraph stop stops it) and registers the repository." },
      { name: "open_ui", summary: "Opens this repository in the browser, already signed in." },
    ],
  },
  {
    title: "Graphs",
    tools: [
      { name: "graph_reference", summary: "The graph format: node types, edges, conditions, loops, rules." },
      { name: "list_graphs", summary: "Graphs saved in the repository." },
      { name: "get_graph", summary: "The full JSON of a graph and whether a run locks it." },
      { name: "save_graph", summary: "Creates or replaces a graph; lays out nodes and returns its validation." },
      { name: "patch_graph", summary: "Edits a saved graph in place (add, update, remove, connect, insert steps); keeps ids and positions." },
      { name: "validate_graph", summary: "Errors and warnings of a saved graph or an unsaved draft." },
      { name: "delete_graph", summary: "Deletes a graph file.", confirmFirst: true },
      { name: "list_commands", summary: "Slash commands and skills available to command steps." },
    ],
  },
  {
    title: "Runs",
    tools: [
      { name: "start_run", summary: "Starts a run of a valid graph." },
      { name: "list_runs", summary: "Run history, newest first." },
      { name: "get_run", summary: "Steps, what needs attention, lanes and the next suggested action." },
      { name: "wait_for_run", summary: "Blocks until the run finishes, pauses or needs the user." },
      { name: "get_node_output", summary: "Full output, error and attempts of one step." },
      { name: "node_action", summary: "Done, fail, retry, skip, hold or release a step." },
      { name: "get_diff", summary: "What a step changed, or a whole lane against the base branch." },
      { name: "get_run_report", summary: "Results, waits, changes, cost and pull requests of a run." },
      { name: "cancel_run", summary: "Cancels a run.", confirmFirst: true },
      { name: "resume_run", summary: "Continues a paused run." },
      { name: "cleanup_run", summary: "Removes a finished run's worktrees.", confirmFirst: true },
    ],
  },
  {
    title: "Approvals (read-only)",
    tools: [
      { name: "list_pending", summary: "Steps waiting for an approval across runs." },
      { name: "get_approval", summary: "What an approval asks for. You approve in the UI, never through Claude." },
    ],
  },
];

/** Every tool name in MCP_TOOL_GROUPS (the registered tools must match this list exactly). */
export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name));

/** GET /api/repos/:repoId/claude-setup: everything the setup wizard needs, computed from the running daemon. */
export const ClaudeSetupResponseSchema = z.object({
  /** promptgraph's own version and the repository it serves. */
  version: z.string(),
  repoPath: z.string(),
  /** Entry point of the running promptgraph CLI (executable; usable as PROMPTGRAPH_BIN). */
  binPath: z.string(),
  /** `claude mcp add` line that registers the MCP server alone (no skills). */
  mcpAddCommand: z.string(),
  plugin: z.object({
    /** The plugin can be added: from this checkout (the marketplace file exists) or, for a desktop runtime, from GitHub. */
    available: z.boolean(),
    /** The checkout that bundles the plugin; null when it comes from GitHub or is unavailable. */
    marketplacePath: z.string().nullable(),
    addMarketplaceCommand: z.string().nullable(),
    installCommand: z.string(),
  }),
  skills: z.array(McpSkillInfoSchema),
  toolGroups: z.array(McpToolGroupSchema),
});
export type ClaudeSetupResponse = z.infer<typeof ClaudeSetupResponseSchema>;

/** POST /api/repos/:repoId/claude-setup/check: runs `claude mcp get promptgraph` in the repository (local and project scopes depend on the directory). */
export const ClaudeCheckResponseSchema = z.object({
  /** The `claude` command ran. */
  claudeFound: z.boolean(),
  /** A `promptgraph` MCP entry is listed (registered by hand or through the plugin). */
  mcpRegistered: z.boolean(),
  /** Last lines of the command output, for the user to read. */
  output: z.string(),
});
export type ClaudeCheckResponse = z.infer<typeof ClaudeCheckResponseSchema>;
