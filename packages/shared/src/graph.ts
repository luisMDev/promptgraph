import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const NODE_TYPES = ["prompt", "command", "shell", "commit", "pr", "approval", "merge", "condition"] as const;
export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;

/** Node types executed by the Claude PTY runner. */
export const CLAUDE_NODE_TYPES = ["prompt", "command"] as const satisfies readonly NodeType[];
/** Node types introduced by Phase 2; rejected by the validator in phase 1 mode. */
export const PHASE2_NODE_TYPES = ["condition"] as const satisfies readonly NodeType[];

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

/**
 * "manual" is promptgraph's name for Claude Code's "default" mode (ask for everything).
 * `bypassPermissions` is deliberately not offered.
 */
export const PermissionModeSchema = z.enum(["acceptEdits", "auto", "manual", "dontAsk", "plan"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ContextModeSchema = z.enum(["fresh", "resume", "clean"]);
export type ContextMode = z.infer<typeof ContextModeSchema>;

export const OnErrorSchema = z.enum(["fail-run", "pause"]);
export type OnError = z.infer<typeof OnErrorSchema>;

export const KeepWorktreesSchema = z.enum(["never", "on-failure", "always"]);
export type KeepWorktrees = z.infer<typeof KeepWorktreesSchema>;

// ---------------------------------------------------------------------------
// Completion policy (§7.4)
// ---------------------------------------------------------------------------

export const CompletionPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto"), graceSec: z.number().min(0).max(3600).default(5) }),
  z.object({ mode: z.literal("manual") }),
  z.object({ mode: z.literal("marker"), token: z.string().default("<<PG_DONE>>") }),
]);
export type CompletionPolicy = z.infer<typeof CompletionPolicySchema>;

export const DEFAULT_COMPLETION: CompletionPolicy = { mode: "auto", graceSec: 5 };

// ---------------------------------------------------------------------------
// Node configs (§6.1, §15.2)
// ---------------------------------------------------------------------------

/** Options shared by `prompt` and `command` (Claude PTY nodes). Unset fields fall back to graph defaults. */
const claudeOptions = {
  context: ContextModeSchema.default("fresh"),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  completion: CompletionPolicySchema.optional(),
};

export const PromptConfigSchema = z.object({ prompt: z.string().default(""), ...claudeOptions });
export type PromptConfig = z.infer<typeof PromptConfigSchema>;

/** `command` is the slash command line itself, e.g. "/code-review high". */
export const CommandConfigSchema = z.object({ command: z.string().default(""), ...claudeOptions });
export type CommandConfig = z.infer<typeof CommandConfigSchema>;

export const ShellConfigSchema = z.object({
  run: z.string().default(""),
  timeoutSec: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type ShellConfig = z.infer<typeof ShellConfigSchema>;

export const CommitConfigSchema = z.object({
  /** Fixed message; used only when generateMessage is false. */
  message: z.string().optional(),
  generateMessage: z.boolean().default(true),
  squashCheckpoints: z.boolean().default(true),
});
export type CommitConfig = z.infer<typeof CommitConfigSchema>;

export const PrConfigSchema = z.object({
  /** Absent title/body are generated with headless claude. */
  title: z.string().optional(),
  body: z.string().optional(),
  draft: z.boolean().default(true),
  /** Defaults to settings.baseBranch. */
  base: z.string().optional(),
  requireApproval: z.boolean().default(true),
});
export type PrConfig = z.infer<typeof PrConfigSchema>;

export const ApprovalConfigSchema = z.object({
  message: z.string().optional(),
  showDiff: z.boolean().default(true),
});
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;

export const MergeConfigSchema = z.object({
  strategy: z.enum(["merge", "squash"]).default("merge"),
  onConflict: z.enum(["claude", "pause"]).default("claude"),
});
export type MergeConfig = z.infer<typeof MergeConfigSchema>;

export const ConditionEvaluatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exitCode"), equals: z.number().int().default(0) }),
  z.object({ kind: z.literal("regex"), pattern: z.string().default(""), flags: z.string().default("") }),
  z.object({
    kind: z.literal("judge"),
    question: z.string().default(""),
    /** Headless model; absent = settings.defaults.model. */
    model: z.string().optional(),
    /** Headless call timeout; absent = 120 s. */
    timeoutSec: z.number().int().positive().optional(),
  }),
]);
export type ConditionEvaluator = z.infer<typeof ConditionEvaluatorSchema>;

export const ConditionConfigSchema = z.object({
  evaluator: ConditionEvaluatorSchema.prefault({ kind: "exitCode" }),
});
export type ConditionConfig = z.infer<typeof ConditionConfigSchema>;

export const NODE_CONFIG_SCHEMAS = {
  prompt: PromptConfigSchema,
  command: CommandConfigSchema,
  shell: ShellConfigSchema,
  commit: CommitConfigSchema,
  pr: PrConfigSchema,
  approval: ApprovalConfigSchema,
  merge: MergeConfigSchema,
  condition: ConditionConfigSchema,
} as const satisfies Record<NodeType, z.ZodType>;

export type NodeConfigMap = { [K in NodeType]: z.infer<(typeof NODE_CONFIG_SCHEMAS)[K]> };
export type NodeConfig = NodeConfigMap[NodeType];

// ---------------------------------------------------------------------------
// Node / Edge
// ---------------------------------------------------------------------------

export const PositionSchema = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof PositionSchema>;

const nodeBase = {
  id: z.string().min(1),
  label: z.string().default(""),
  position: PositionSchema.prefault({ x: 0, y: 0 }),
  /** Applies only when no matching failure edge exists (Phase 2). Default "pause". */
  onError: OnErrorSchema.optional(),
  /** Phase 2 join policy for nodes with several inputs. Only "all" exists today. */
  join: z.literal("all").optional(),
};

export const PromptNodeSchema = z.object({ ...nodeBase, type: z.literal("prompt"), config: PromptConfigSchema.prefault({}) });
export const CommandNodeSchema = z.object({ ...nodeBase, type: z.literal("command"), config: CommandConfigSchema.prefault({}) });
export const ShellNodeSchema = z.object({ ...nodeBase, type: z.literal("shell"), config: ShellConfigSchema.prefault({}) });
export const CommitNodeSchema = z.object({ ...nodeBase, type: z.literal("commit"), config: CommitConfigSchema.prefault({}) });
export const PrNodeSchema = z.object({ ...nodeBase, type: z.literal("pr"), config: PrConfigSchema.prefault({}) });
export const ApprovalNodeSchema = z.object({ ...nodeBase, type: z.literal("approval"), config: ApprovalConfigSchema.prefault({}) });
export const MergeNodeSchema = z.object({ ...nodeBase, type: z.literal("merge"), config: MergeConfigSchema.prefault({}) });
export const ConditionNodeSchema = z.object({ ...nodeBase, type: z.literal("condition"), config: ConditionConfigSchema.prefault({}) });

export const NodeSchema = z.discriminatedUnion("type", [
  PromptNodeSchema,
  CommandNodeSchema,
  ShellNodeSchema,
  CommitNodeSchema,
  PrNodeSchema,
  ApprovalNodeSchema,
  MergeNodeSchema,
  ConditionNodeSchema,
]);
export type GraphNode = z.infer<typeof NodeSchema>;
export type GraphNodeOf<T extends NodeType> = Extract<GraphNode, { type: T }>;
export type ClaudeNode = GraphNodeOf<"prompt"> | GraphNodeOf<"command">;

/** Output ports. "out" for all nodes, "true"/"false" for condition nodes, "error" for failure edges (Phase 2). */
export const SourcePortSchema = z.enum(["out", "true", "false", "error"]);
export type SourcePort = z.infer<typeof SourcePortSchema>;

export const EdgeWhenSchema = z.enum(["success", "failure", "always"]);
export type EdgeWhen = z.infer<typeof EdgeWhenSchema>;

export const LoopSpecSchema = z.object({
  maxIterations: z.number().int().min(1).max(100),
  onExhausted: z.enum(["fail", "continue"]).default("fail"),
});
export type LoopSpec = z.infer<typeof LoopSpecSchema>;

export const EdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourcePort: SourcePortSchema.default("out"),
  target: z.string().min(1),
  targetPort: z.literal("in").default("in"),
  /** Phase 2. Absent = "success", or "failure" when sourcePort is "error". */
  when: EdgeWhenSchema.optional(),
  /** Phase 2: marks a loop back-edge. */
  loop: LoopSpecSchema.optional(),
});
export type GraphEdge = z.infer<typeof EdgeSchema>;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export const GraphDefaultsSchema = z.object({
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  permissionMode: PermissionModeSchema.default("acceptEdits"),
  allowedTools: z.array(z.string()).optional(),
  completion: CompletionPolicySchema.prefault(DEFAULT_COMPLETION),
});
export type GraphDefaults = z.infer<typeof GraphDefaultsSchema>;

export const GraphSettingsSchema = z.object({
  baseBranch: z.string().min(1).default("main"),
  /** Empty = "pg/<graph-id>" (see resolveBranchPrefix). */
  branchPrefix: z.string().default(""),
  maxParallelClaude: z.number().int().min(1).max(16).default(3),
  workspaceSetup: z.string().optional(),
  defaults: GraphDefaultsSchema.prefault({}),
  keepWorktrees: KeepWorktreesSchema.default("on-failure"),
  /** Pre-accept Claude Code's trust dialog for each new worktree (SPIKE A5). */
  autoTrustWorktrees: z.boolean().default(true),
  /** Unlocks `pr.requireApproval: false` in the UI and validator. */
  allowPrWithoutApproval: z.boolean().default(false),
});
export type GraphSettings = z.infer<typeof GraphSettingsSchema>;

export const GRAPH_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const GraphIdSchema = z.string().regex(GRAPH_ID_PATTERN, "lowercase letters, digits and dashes");

export const GraphSchema = z.object({
  version: z.literal(1),
  id: GraphIdSchema,
  name: z.string().min(1),
  settings: GraphSettingsSchema.prefault({}),
  nodes: z.array(NodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
});
export type Graph = z.infer<typeof GraphSchema>;
/** Shape accepted on input (defaults may be omitted). */
export type GraphInput = z.input<typeof GraphSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isClaudeNode(node: GraphNode): node is ClaudeNode {
  return node.type === "prompt" || node.type === "command";
}

export function defaultNodeConfig<T extends NodeType>(type: T): NodeConfigMap[T] {
  return NODE_CONFIG_SCHEMAS[type].parse({}) as NodeConfigMap[T];
}

export function resolveBranchPrefix(graph: Pick<Graph, "id" | "settings">): string {
  return graph.settings.branchPrefix.trim() || `pg/${graph.id}`;
}

export function slugifyGraphId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "graph";
}

/** Effective edge condition: `when` if set, otherwise "failure" for the error port and "success" elsewhere. */
export function edgeWhen(edge: Pick<GraphEdge, "when" | "sourcePort">): EdgeWhen {
  return edge.when ?? (edge.sourcePort === "error" ? "failure" : "success");
}

/** Outcome of a finished NodeRun, used for edge matching (§8.1). */
export type NodeOutcome = { kind: "success"; port?: "true" | "false" } | { kind: "failure" };

/** Whether an edge delivers an activation (true) or a skip (false) for the given outcome of its source. */
export function edgeMatches(edge: GraphEdge, outcome: NodeOutcome): boolean {
  const when = edgeWhen(edge);
  if (when === "always") return true;
  if (when === "failure") return outcome.kind === "failure";
  if (outcome.kind !== "success") return false;
  if (edge.sourcePort === "true" || edge.sourcePort === "false") return outcome.port === edge.sourcePort;
  return true;
}

/** Canvas order: left to right, then top to bottom, then id for stability. */
export function compareCanvasOrder(a: Pick<GraphNode, "id" | "position">, b: Pick<GraphNode, "id" | "position">): number {
  return a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id);
}

export function createEmptyGraph(id: string, name: string, baseBranch = "main"): Graph {
  return GraphSchema.parse({ version: 1, id, name, settings: { baseBranch } });
}
