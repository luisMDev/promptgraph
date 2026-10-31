import path from "node:path";
import { onTestFinished, vi } from "vitest";
import {
  GraphSchema,
  type ApprovalRequest,
  type GraphInput,
  type Lane,
  type NodeRunOutput,
  type NodeType,
  type PlannedLane,
  type Run,
} from "@promptgraph/shared";
import { getPaths } from "../../src/config/paths.js";
import { Engine } from "../../src/engine/engine.js";
import { EventBus, type BusEvents } from "../../src/events/bus.js";
import { GraphStore } from "../../src/graphs/graph-store.js";
import type { PtyManager } from "../../src/pty/pty-manager.js";
import type { ClaudeRunner } from "../../src/runners/claude/claude-runner.js";
import type { NodeExecution, Runner, RunnerContext, RunnerRegistry, RunnerResult } from "../../src/runners/types.js";
import { openDatabase, Store } from "../../src/store/store.js";
import type { LaneManager } from "../../src/workspace/lane-manager.js";
import { tempDir, waitFor } from "../helpers.js";

/** Engine test fakes (engine.test.ts, engine-flow.test.ts): the engine only talks to these through the CONTRACTS interfaces. */
/** A started node; the test settles it (or the runner auto-settles in "auto" mode). */
export class FakeExecution {
  readonly calls: string[] = [];
  private settle!: (r: RunnerResult) => void;
  readonly result = new Promise<RunnerResult>((r) => (this.settle = r));
  settled = false;
  constructor(readonly ctx: RunnerContext) {}
  finish(r: RunnerResult): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(r);
  }
  succeed(output: NodeRunOutput = { text: `out:${this.ctx.node.id}` }): void {
    this.finish({ status: "succeeded", output });
  }
  failWith(error = `boom:${this.ctx.node.id}`): void {
    this.finish({ status: "failed", error });
  }
}

export class FakeRunner implements Runner {
  readonly started: FakeExecution[] = [];
  constructor(private readonly behaviour: (e: FakeExecution) => void = (e) => queueMicrotask(() => e.succeed())) {}

  start(ctx: RunnerContext): NodeExecution {
    const e = new FakeExecution(ctx);
    this.started.push(e);
    this.behaviour(e);
    return {
      result: e.result,
      controls: {
        done: () => (e.calls.push("done"), e.succeed()),
        fail: (reason?: string) => (e.calls.push(`fail:${reason ?? ""}`), e.failWith(reason ?? "failed by user")),
        setHold: (hold: boolean) => e.calls.push(`hold:${hold}`),
        approve: (req: ApprovalRequest) => (e.calls.push(`approve:${req.approved}`), e.succeed({ approved: req.approved })),
        userInput: () => e.calls.push("input"),
        cancel: async () => {
          e.calls.push("cancel");
          e.finish({ status: "cancelled" });
        },
      },
    };
  }

  byNode(nodeId: string): FakeExecution[] {
    return this.started.filter((e) => e.ctx.node.id === nodeId);
  }
  last(nodeId: string): FakeExecution | undefined {
    return this.byNode(nodeId).at(-1);
  }
}

export class FakeLanes {
  readonly calls: string[] = [];
  failCreate: string | null = null;
  /** createLane of these lane ids waits for this promise (fork-lane creation in flight). */
  gate: { laneIds: string[]; until: Promise<void> } | null = null;
  private heads = 0;
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly root: string,
  ) {}
  async createLane(run: Run, planned: PlannedLane, fromRef: string): Promise<Lane> {
    if (this.gate?.laneIds.includes(planned.id)) await this.gate.until;
    this.calls.push(`create:${planned.id}:${fromRef}`);
    if (this.failCreate) throw new Error(this.failCreate);
    const lane = this.store.insertLane({
      id: planned.id,
      runId: run.id,
      branch: `pg/${run.graphId}/${run.shortId}/${planned.id}`,
      worktreePath: path.join(this.root, run.id, planned.id),
      baseRef: fromRef,
      index: planned.index,
    });
    this.bus.emit("lane:update", { lane });
    return lane;
  }
  async checkpoint(lane: Lane, afterLabel: string): Promise<string | null> {
    this.calls.push(`checkpoint:${lane.id}:${afterLabel}`);
    return null;
  }
  /** resetInterruptedMerge reports these lanes as left mid-merge (once). */
  readonly midMerge = new Set<string>();
  /** headSha of these lanes (instead of a new sha per call). */
  readonly heads_ = new Map<string, string>();
  async resetInterruptedMerge(lane: Lane): Promise<boolean> {
    this.calls.push(`reset-merge:${lane.id}`);
    return this.midMerge.delete(lane.id);
  }
  async headSha(lane: Lane): Promise<string> {
    return this.heads_.get(lane.id) ?? `head-${lane.id}-${++this.heads}`;
  }
  async diff(lane: Lane, base: string, opts: { committedOnly?: boolean } = {}) {
    this.calls.push(`diff:${lane.id}:${base}${opts.committedOnly ? ":committed" : ""}`);
    return { base, head: "h", files: [], patch: "", truncated: false };
  }
  async cleanup(runId: string, opts: { keep: string; failed: boolean; force?: boolean }): Promise<void> {
    this.calls.push(`cleanup:${opts.keep}:${opts.failed}${opts.force ? ":force" : ""}`);
    this.store.updateRun(runId, { cleanedUp: true });
  }
  async prune(): Promise<void> {
    this.calls.push("prune");
  }
  async shortIdHasBranches(): Promise<boolean> {
    return false;
  }
}

export interface Setup {
  engine: Engine;
  store: Store;
  graphs: GraphStore;
  bus: EventBus;
  lanes: FakeLanes;
  ptys: { killAll: ReturnType<typeof vi.fn> };
  claude: { reopen: ReturnType<typeof vi.fn>; isSessionActive: ReturnType<typeof vi.fn> };
  events: Array<{ name: keyof BusEvents; payload: unknown }>;
  attention: Array<BusEvents["attention"]>;
  makeEngine: (runners: RunnerRegistry) => Engine;
}

export function setup(runners: RunnerRegistry, opts: { phase?: 1 | 2 } = {}): Setup {
  const t = tempDir();
  onTestFinished(t.cleanup);
  const bus = new EventBus();
  const events: Setup["events"] = [];
  const attention: Setup["attention"] = [];
  for (const name of ["run:update", "node:update", "lane:update"] as const) bus.on(name, (payload) => events.push({ name, payload }));
  bus.on("attention", (a) => attention.push(a));
  const store = new Store(openDatabase(":memory:"));
  const graphs = new GraphStore(t.dir, bus);
  const lanes = new FakeLanes(store, bus, path.join(t.dir, "wt"));
  const ptys = { killAll: vi.fn(async () => {}) };
  const claude = { reopen: vi.fn(async () => ({ ptyId: "reopen-x", notice: null })), isSessionActive: vi.fn(() => false) };
  const makeEngine = (r: RunnerRegistry) =>
    new Engine({
      store,
      graphs,
      lanes: lanes as unknown as LaneManager,
      ptys: ptys as unknown as PtyManager,
      runners: r,
      claude: claude as unknown as ClaudeRunner,
      bus,
      paths: getPaths({ PG_HOME: path.join(t.dir, "pg-home") }),
      repo: { path: t.dir, name: path.basename(t.dir) },
      phase: opts.phase ?? 1,
      env: {},
      stopTimeoutMs: 500,
    });
  return { engine: makeEngine(runners), store, graphs, bus, lanes, ptys, claude, events, attention, makeEngine };
}

export type NodeSpec = { id: string; type?: NodeType; x?: number; y?: number; onError?: "fail-run" | "pause"; label?: string; config?: object };

export type EdgeSpec = [string, string] | NonNullable<GraphInput["edges"]>[number];

export function makeGraph(nodes: NodeSpec[], edges: EdgeSpec[], settings: GraphInput["settings"] = {}) {
  const config = (type: NodeType) =>
    ({ prompt: { prompt: "do it" }, command: { command: "/simplify" }, shell: { run: "true" } })[type as "prompt"] ?? {};
  return GraphSchema.parse({
    version: 1,
    id: "flow",
    name: "Flow",
    settings,
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type ?? "prompt",
      label: n.label ?? n.id.toUpperCase(),
      position: { x: n.x ?? i * 200, y: n.y ?? 0 },
      config: n.config ?? config(n.type ?? "prompt"),
      ...(n.onError ? { onError: n.onError } : {}),
    })),
    edges: edges.map((e) => (Array.isArray(e) ? { id: `${e[0]}-${e[1]}`, source: e[0], target: e[1] } : e)),
  });
}

export const statusOf = (s: Setup, runId: string) =>
  Object.fromEntries([...new Map(s.store.listNodeRuns(runId).map((n) => [n.nodeId, n])).values()].map((n) => [n.nodeId, n.status]));
export const runStatus = (s: Setup, runId: string) => s.store.getRun(runId)!.status;
export const waitRun = (s: Setup, runId: string, status: string) => waitFor(() => runStatus(s, runId) === status, 3000);

export const allTypes = (runner: Runner): RunnerRegistry =>
  Object.fromEntries((["prompt", "command", "shell", "commit", "pr", "approval", "merge"] as const).map((t) => [t, runner]));

