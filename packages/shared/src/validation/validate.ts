import {
  CLAUDE_NODE_TYPES,
  isClaudeNode,
  isPhase2NodeType,
  edgeWhen,
  type CompletionPolicy,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
} from "../graph.js";
import {
  buildTopology,
  computeLanePlan,
  edgesMutuallyExclusive,
  findCycle,
  loopBody,
  type LanePlan,
  type Topology,
} from "../topology.js";
import { regexError } from "../condition.js";
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
  checkBranchPrefix(graph.settings.branchPrefix, out);
  for (const node of graph.nodes) {
    if (options.supportedNodeTypes && !options.supportedNodeTypes.includes(node.type) && !(phase === 1 && isPhase2NodeType(node.type))) {
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

  const plan = cycle ? null : computeLanePlan(graph);
  checkJoins(topo, plan, out, phase);
  checkLoops(topo, plan, out);
  checkFailureRouting(topo, out, phase);
  if (plan) {
    checkResumeContext(topo, plan, out);
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
    if (e.source === e.target && !e.loop) {
      out.error({
        code: "self_loop",
        message: phase === 2 ? "A node cannot connect to itself unless the edge is a loop (repeat the node)." : "A node cannot connect to itself.",
        edgeId: e.id,
      });
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
    if ((e.sourcePort === "true" || e.sourcePort === "false") && when !== "success") {
      out.error({
        code: "invalid_port",
        message: `Edges from the "${e.sourcePort}" port fire when the condition is ${e.sourcePort}; use the error port for failures.`,
        edgeId: e.id,
      });
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

/** Slash-separated segments of letters, digits, "_", "." and "-"; no segment starts with "." or "-" (§9.1). */
const BRANCH_PREFIX_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/** A lane branch `<prefix>/<run>/<lane>` must be a plain git ref name (no "+x" refspecs, "-x" options, ".."). */
function checkBranchPrefix(prefix: string, out: Collector): void {
  const p = prefix.trim();
  if (!p || (BRANCH_PREFIX_PATTERN.test(p) && !/\.\.|\.lock(\/|$)|\.(\/|$)/.test(p))) return;
  out.error({
    code: "invalid_config",
    message: `Branch prefix "${p}" is not a valid branch name: use letters, digits, "_", "." and "-" separated by "/".`,
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
      if (phase === 1 && isPhase2NodeType(node.type)) {
        out.error({ code: "phase2_unsupported", message: "Condition nodes are not supported yet.", nodeId: node.id });
        break;
      }
      const ev = node.config.evaluator;
      if (ev.kind === "judge" && !ev.question.trim()) missing(node, out, "Judge question is empty.");
      if (ev.kind === "regex") {
        if (!ev.pattern) missing(node, out, "Regex pattern is empty.");
        else {
          const invalid = regexError(ev.pattern, ev.flags);
          if (invalid) out.error({ code: "invalid_config", message: `Invalid regex: ${invalid}`, nodeId: node.id });
        }
      }
      break;
    }
  }
}

/**
 * Joins (§9.2 rule 5, §15.3): a non-merge node with several inputs is invalid, unless (phase 2) every
 * pair of inputs comes from mutually exclusive branches (`edgesMutuallyExclusive`) that run in the same
 * lane (otherwise their work is in different worktrees and only a merge can combine it). Merge nodes need
 * at least two inputs.
 */
function checkJoins(topo: Topology, plan: LanePlan | null, out: Collector, phase: 1 | 2): void {
  const exclusiveCache = new Map<string, Set<string>>();
  for (const node of topo.nodes.values()) {
    const inputs = topo.incoming.get(node.id)!;
    if (node.type === "merge") {
      if (inputs.length < 2) {
        out.error({ code: "merge_input_count", message: "A merge node needs at least two inputs.", nodeId: node.id });
      }
      continue;
    }
    if (node.type === "condition" && inputs.length === 0) {
      // Loop edges do not count: the condition needs a forward predecessor to evaluate on its first pass.
      out.error({ code: "condition_input", message: "A condition node evaluates its predecessor; connect one.", nodeId: node.id });
    }
    if (phase === 2 && node.type === "condition" && node.config.evaluator.kind === "exitCode" && inputs.some((e) => topo.nodes.get(e.source)?.type !== "shell")) {
      out.error({ code: "invalid_config", message: "An exit-code condition needs a shell predecessor.", nodeId: node.id });
    }
    if (phase === 2 && node.type === "condition" && node.config.evaluator.kind === "exitCode") {
      for (const e of inputs) {
        if (topo.nodes.get(e.source)?.type !== "shell" || edgeWhen(e) !== "success") continue;
        out.warn({
          code: "condition_input",
          message:
            "A failing shell step (exit code ≠ 0) fails and never reaches this condition through a success edge; " +
            'set the edge to "always" so the condition also evaluates failures.',
          nodeId: node.id,
          edgeId: e.id,
        });
      }
    }
    if (inputs.length < 2) continue;
    if (phase === 1) {
      out.error({ code: "invalid_join", message: "Only merge nodes can join parallel branches. Insert a merge node.", nodeId: node.id });
      continue;
    }
    if (!allPairsExclusive(topo, inputs, exclusiveCache)) {
      out.error({
        code: "invalid_join",
        message:
          "These inputs can both run, so only a merge node can join them. A plain join is allowed only for branches " +
          "that exclude each other: the true/false ports of one condition, or a step and its failure path.",
        nodeId: node.id,
      });
      continue;
    }
    if (plan && new Set(inputs.map((e) => plan.edgeLane.get(e.id))).size > 1) {
      out.error({
        code: "invalid_join",
        message: "These exclusive branches run in different lanes (a parallel branch starts on one of them); join them with a merge node.",
        nodeId: node.id,
      });
    }
  }
}

function allPairsExclusive(topo: Topology, inputs: readonly GraphEdge[], cache: Map<string, Set<string>>): boolean {
  for (let i = 0; i < inputs.length; i++)
    for (let j = i + 1; j < inputs.length; j++)
      if (!edgesMutuallyExclusive(topo, inputs[i]!, inputs[j]!, cache)) return false;
  return true;
}

/**
 * §15.4 loops. Errors (`invalid_loop`): the edge must point back to an ancestor of its source (or to the
 * source itself: repeat one node); two loop bodies must be disjoint or one strictly inside the other
 * (they are repeated as a unit); a body runs in one lane, so it cannot contain merge nodes nor start
 * parallel branches (forks would have to be re-created on every iteration); an exit-code/regex condition
 * cannot be the loop target (its predecessor is outside the body, so it re-checks the same output). Warning
 * `unconditional_loop`: an edge that loops back on every outcome with onExhausted "fail" always ends
 * in a failure.
 */
function checkLoops(topo: Topology, plan: LanePlan | null, out: Collector): void {
  const bodies: Array<{ edge: GraphEdge; body: Set<string> }> = [];
  for (const e of topo.loopEdges) {
    const body = loopBody(topo, e);
    if (body.size === 0) {
      out.error({
        code: "invalid_loop",
        message: "A loop edge must point back to an earlier step on the same path (an ancestor of its source).",
        edgeId: e.id,
      });
      continue;
    }
    bodies.push({ edge: e, body });
    const target = topo.nodes.get(e.target)!;
    if (target.type === "condition" && target.config.evaluator.kind !== "judge") {
      // Its forward predecessors are outside the body: every pass would re-check the same output.
      out.error({
        code: "invalid_loop",
        message: "This loop re-runs the condition on the same output, so it can never change: loop back to the step the condition evaluates.",
        edgeId: e.id,
      });
    }
    if (alwaysLoopsBack(topo, e, body) && e.loop!.onExhausted === "fail") {
      out.warn({
        code: "unconditional_loop",
        message:
          `Nothing stops this loop but a failure: its steps run ${e.loop!.maxIterations + 1} times and then the run fails. ` +
          'Loop back from a condition\'s true/false port or a failure edge, or set "when exhausted" to continue.',
        edgeId: e.id,
      });
    }
    const merge = [...body].map((id) => topo.nodes.get(id)!).find((n) => n.type === "merge");
    if (merge) {
      out.error({
        code: "invalid_loop",
        message: `Loop steps run in one lane and cannot contain a merge node ("${labelOf(merge)}").`,
        edgeId: e.id,
        nodeId: merge.id,
      });
      continue;
    }
    if (!plan) continue;
    const lane = plan.laneOf.get(e.target);
    for (const id of body) {
      const forks = (topo.outgoing.get(id) ?? []).some((o) => plan.edgeLane.get(o.id) !== lane);
      if (plan.laneOf.get(id) !== lane || forks) {
        out.error({
          code: "invalid_loop",
          message: `Loop steps run in one lane: "${labelOf(topo.nodes.get(id)!)}" starts parallel branches. Move the fan-out after the loop.`,
          edgeId: e.id,
          nodeId: id,
        });
        break;
      }
    }
  }
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i]!;
      const b = bodies[j]!;
      const shared = [...a.body].filter((id) => b.body.has(id)).length;
      if (shared === 0) continue;
      const nested = (shared === b.body.size) !== (shared === a.body.size); // strictly inside
      if (nested) continue;
      out.error({
        code: "invalid_loop",
        message:
          shared === a.body.size && shared === b.body.size
            ? "Two loop edges repeat exactly the same steps; keep one loop edge."
            : "Loops overlap: one loop must contain the other entirely, or they must not share steps.",
        edgeId: b.edge.id,
      });
    }
  }
}

/**
 * Whether nothing but a failure can stop the loop: an "always" edge, or a success edge from the out port
 * when no step of the body branches (no condition, no failure edge), so the source runs and succeeds on
 * every pass.
 */
function alwaysLoopsBack(topo: Topology, e: GraphEdge, body: ReadonlySet<string>): boolean {
  const when = edgeWhen(e);
  if (when === "always") return true;
  if (when !== "success" || e.sourcePort !== "out") return false;
  return [...body].every(
    (id) => topo.nodes.get(id)!.type !== "condition" && (topo.outgoing.get(id) ?? []).every((o) => edgeWhen(o) === "success"),
  );
}

/** Phase 2 (§15.1): onError only applies to failures that no failure edge handles. */
function checkFailureRouting(topo: Topology, out: Collector, phase: 1 | 2): void {
  if (phase === 1) return;
  for (const node of topo.nodes.values()) {
    if (!node.onError) continue;
    const routed = (topo.outgoing.get(node.id) ?? []).some((e) => edgeWhen(e) !== "success");
    if (routed) {
      out.warn({
        code: "on_error_ignored",
        message: `"On error: ${node.onError}" has no effect: failures of this step follow its failure edge.`,
        nodeId: node.id,
      });
    }
  }
}

/**
 * §7.5: resume is valid when exactly one predecessor exists and it is a Claude node in the same lane.
 * §15.4: inside a loop body a resume node continues its own session from the previous iteration, so the
 * rule only matters for its first pass; when it does not hold there, the first pass starts a new session
 * with the predecessors' outputs (like "fresh").
 */
function checkResumeContext(topo: Topology, plan: LanePlan, out: Collector): void {
  const inLoop = new Set(topo.loopEdges.flatMap((e) => [...loopBody(topo, e)]));
  for (const node of topo.nodes.values()) {
    if (!isClaudeNode(node) || node.config.context !== "resume" || inLoop.has(node.id)) continue;
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
