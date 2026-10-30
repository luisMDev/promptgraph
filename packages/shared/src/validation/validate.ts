import {
  CLAUDE_NODE_TYPES,
  isClaudeNode,
  edgeWhen,
  type CompletionPolicy,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
} from "../graph.js";
import {
  ancestors,
  buildTopology,
  computeLanePlan,
  edgesMutuallyExclusive,
  findCycle,
  type Topology,
} from "../topology.js";
import type { ValidateOptions, ValidationIssue, ValidationResult } from "./types.js";

/** Node types whose work leaves uncommitted changes in the lane (for the §18 Q1 warning). */
const WORK_NODE_TYPES: readonly NodeType[] = [...CLAUDE_NODE_TYPES, "shell"];
/** Node types that end with a commit in the lane. */
const COMMITTING_NODE_TYPES: readonly NodeType[] = ["commit", "merge"];

class Collector {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];
  error(issue: ValidationIssue): void {
    this.errors.push(issue);
  }
  warn(issue: ValidationIssue): void {
    this.warnings.push(issue);
  }
}

/**
 * Validates a parsed graph (zod already enforced field shapes). Pure; used by server and web.
 * Structural errors short-circuit later checks that would be meaningless (e.g. lanes on a cyclic graph).
 */
export function validateGraph(graph: Graph, options: ValidateOptions = {}): ValidationResult {
  const phase = options.phase ?? 2;
  const out = new Collector();

  if (graph.nodes.length === 0) {
    out.error({ code: "empty_graph", message: "The graph has no nodes." });
    return { errors: out.errors, warnings: out.warnings };
  }

  checkIdsAndEdges(graph, out, phase);
  const topo = buildTopology(graph);
  const cycle = findCycle(topo);
  if (cycle) {
    const labels = cycle.map((id) => labelOf(topo.nodes.get(id)!)).join(" → ");
    out.error({
      code: "cycle",
      message:
        phase === 2
          ? `Cycle detected: ${labels}. Mark a back-edge as a loop to repeat steps.`
          : `Cycle detected: ${labels}. Remove one of these edges.`,
      nodeId: cycle[0],
    });
  }

  checkCompletion(graph.settings.defaults.completion, out, null);
  for (const node of graph.nodes) {
    if (options.supportedNodeTypes && !options.supportedNodeTypes.includes(node.type) && !(phase === 1 && node.type === "condition")) {
      out.error({
        code: "unsupported_node_type",
        message: `${node.type} nodes are not supported by this version yet.`,
        nodeId: node.id,
      });
    }
    checkNodeConfig(graph, node, out, phase);
    if (isClaudeNode(node) && node.config.completion) checkCompletion(node.config.completion, out, node.id);
    if (!node.label.trim()) out.warn({ code: "empty_label", message: "Node has no label.", nodeId: node.id });
  }

  checkJoins(topo, out, phase);
  checkLoops(topo, out);
  if (!cycle) {
    checkResumeContext(graph, topo, out);
    checkUncommittedWork(topo, out);
  }
  return { errors: out.errors, warnings: out.warnings };
}

function labelOf(node: GraphNode): string {
  return node.label.trim() || `${node.type} ${node.id}`;
}

function validSourcePorts(type: NodeType): readonly string[] {
  return type === "condition" ? ["true", "false", "error"] : ["out", "error"];
}

function checkIdsAndEdges(graph: Graph, out: Collector, phase: 1 | 2): void {
  const nodeIds = new Set<string>();
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) out.error({ code: "duplicate_node_id", message: `Duplicate node id "${n.id}".`, nodeId: n.id });
    nodeIds.add(n.id);
  }
  const nodes = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) out.error({ code: "duplicate_edge_id", message: `Duplicate edge id "${e.id}".`, edgeId: e.id });
    edgeIds.add(e.id);
    const src = nodes.get(e.source);
    if (!src || !nodes.has(e.target)) {
      out.error({ code: "dangling_edge", message: "Edge points to a missing node.", edgeId: e.id });
      continue;
    }
    if (e.source === e.target) {
      out.error({ code: "self_loop", message: "A node cannot connect to itself.", edgeId: e.id });
      continue;
    }
    const pair = `${e.source}:${e.sourcePort}->${e.target}:${e.loop ? "loop" : "fwd"}`;
    if (pairs.has(pair)) out.error({ code: "duplicate_edge", message: "Duplicate connection.", edgeId: e.id });
    pairs.add(pair);
    if (!validSourcePorts(src.type).includes(e.sourcePort)) {
      out.error({ code: "invalid_port", message: `Port "${e.sourcePort}" does not exist on a ${src.type} node.`, edgeId: e.id });
    }
    const when = edgeWhen(e);
    if (e.sourcePort === "error" && when !== "failure") {
      out.error({ code: "invalid_port", message: "Edges from the error port must use when = failure.", edgeId: e.id });
    }
    if (phase === 1 && (e.loop || when !== "success" || e.sourcePort !== "out")) {
      out.error({
        code: "phase2_unsupported",
        message: "Edge conditions, error ports and loops are not supported yet.",
        edgeId: e.id,
      });
    }
  }
}

/** An empty marker token is contained in every message: the node would succeed on any Stop. */
function checkCompletion(policy: CompletionPolicy, out: Collector, nodeId: string | null): void {
  if (policy.mode !== "marker" || policy.token.trim()) return;
  out.error({
    code: "invalid_config",
    message: nodeId ? "Marker token is empty." : "The default completion marker token is empty (graph settings).",
    ...(nodeId ? { nodeId } : {}),
  });
}

function missing(node: GraphNode, out: Collector, message: string): void {
  out.error({ code: "missing_config", message, nodeId: node.id });
}

function checkNodeConfig(graph: Graph, node: GraphNode, out: Collector, phase: 1 | 2): void {
  switch (node.type) {
    case "prompt":
      if (!node.config.prompt.trim()) missing(node, out, "Prompt is empty.");
      break;
    case "command": {
      const cmd = node.config.command.trim();
      if (!cmd) missing(node, out, "Slash command is empty.");
      else if (!cmd.startsWith("/"))
        out.error({ code: "invalid_config", message: 'Slash command must start with "/".', nodeId: node.id });
      break;
    }
    case "shell":
      if (!node.config.run.trim()) missing(node, out, "Shell command is empty.");
      break;
    case "commit":
      if (!node.config.generateMessage && !node.config.message?.trim())
        missing(node, out, "Commit message is empty (or enable generated messages).");
      break;
    case "pr":
      if (!node.config.requireApproval && !graph.settings.allowPrWithoutApproval) {
        out.error({
          code: "pr_requires_approval",
          message: "PR nodes require approval unless unlocked in graph settings.",
          nodeId: node.id,
        });
      }
      break;
    case "approval":
    case "merge":
      break;
    case "condition": {
      if (phase === 1) {
        out.error({ code: "phase2_unsupported", message: "Condition nodes are not supported yet.", nodeId: node.id });
        break;
      }
      const ev = node.config.evaluator;
      if (ev.kind === "judge" && !ev.question.trim()) missing(node, out, "Judge question is empty.");
      if (ev.kind === "regex") {
        if (!ev.pattern) missing(node, out, "Regex pattern is empty.");
        else {
          try {
            new RegExp(ev.pattern, ev.flags);
          } catch (err) {
            out.error({ code: "invalid_config", message: `Invalid regex: ${(err as Error).message}`, nodeId: node.id });
          }
        }
      }
      break;
    }
  }
}

/**
 * Joins (§9.2 rule 5, §15.3): a non-merge node with several inputs is invalid, unless (phase 2) every
 * pair of inputs comes from mutually exclusive branches. Merge nodes need at least two inputs.
 */
function checkJoins(topo: Topology, out: Collector, phase: 1 | 2): void {
  for (const node of topo.nodes.values()) {
    const inputs = topo.incoming.get(node.id)!;
    if (node.type === "merge") {
      if (inputs.length < 2) {
        out.error({ code: "merge_input_count", message: "A merge node needs at least two inputs.", nodeId: node.id });
      }
      continue;
    }
    if (node.type === "condition" && inputs.length === 0) {
      out.warn({ code: "condition_input", message: "A condition node evaluates its predecessor; connect one.", nodeId: node.id });
    }
    if (inputs.length < 2) continue;
    if (phase === 2 && allPairsExclusive(topo, inputs)) continue;
    out.error({
      code: "invalid_join",
      message: "Only merge nodes can join parallel branches. Insert a merge node.",
      nodeId: node.id,
    });
  }
}

function allPairsExclusive(topo: Topology, inputs: readonly GraphEdge[]): boolean {
  for (let i = 0; i < inputs.length; i++)
    for (let j = i + 1; j < inputs.length; j++)
      if (!edgesMutuallyExclusive(topo, inputs[i]!, inputs[j]!)) return false;
  return true;
}

/** §15.4: a loop edge must point to an ancestor of its source (the target reaches the source). */
function checkLoops(topo: Topology, out: Collector): void {
  for (const e of topo.loopEdges) {
    if (!ancestors(topo, e.source).has(e.target)) {
      out.error({ code: "invalid_loop", message: "A loop edge must point back to an earlier node on the same path.", edgeId: e.id });
    }
  }
}

/** §7.5: resume is valid when exactly one predecessor exists and it is a Claude node in the same lane. */
function checkResumeContext(graph: Graph, topo: Topology, out: Collector): void {
  const plan = computeLanePlan(graph);
  for (const node of topo.nodes.values()) {
    if (!isClaudeNode(node) || node.config.context !== "resume") continue;
    const inputs = topo.incoming.get(node.id)!;
    const pred = inputs.length === 1 ? topo.nodes.get(inputs[0]!.source)! : undefined;
    let reason: string | null = null;
    if (!pred) reason = "needs exactly one predecessor";
    else if (!isClaudeNode(pred)) reason = "the predecessor must be a prompt or command node";
    else if (plan.laneOf.get(pred.id) !== plan.laneOf.get(node.id)) reason = "the predecessor runs in a different lane";
    if (reason) {
      out.error({ code: "invalid_resume_context", message: `Context "resume" ${reason}.`, nodeId: node.id });
    }
  }
}

/** §18 Q1: pr/merge after work with no commit in between → automatic checkpoint, warn. */
function checkUncommittedWork(topo: Topology, out: Collector): void {
  const hasUncommitted = (startEdges: readonly GraphEdge[]): boolean => {
    const seen = new Set<string>();
    const stack = startEdges.map((e) => e.source);
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = topo.nodes.get(id)!;
      if (COMMITTING_NODE_TYPES.includes(n.type)) continue;
      if (WORK_NODE_TYPES.includes(n.type)) return true;
      for (const e of topo.incoming.get(id)!) stack.push(e.source);
    }
    return false;
  };
  for (const node of topo.nodes.values()) {
    const inputs = topo.incoming.get(node.id)!;
    if (node.type === "pr" && hasUncommitted(inputs)) {
      out.warn({
        code: "uncommitted_before_pr",
        message: "Changes since the last commit node will be committed automatically as a checkpoint before the PR.",
        nodeId: node.id,
      });
    }
    if (node.type === "merge" && inputs.some((e) => hasUncommitted([e]))) {
      out.warn({
        code: "uncommitted_before_merge",
        message: "Uncommitted changes in an input lane will be checkpointed automatically before merging.",
        nodeId: node.id,
      });
    }
  }
}
