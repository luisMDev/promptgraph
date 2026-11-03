import type { NodeRun, RunDetail } from "@promptgraph/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoApi } from "../api/rest";
import { graphOf, nodeRunOf, runDetailOf } from "../test-fixtures";
import { createRepoCache, type RepoCache } from "./repo-cache";

const pending = vi.fn<() => Promise<{ nodeRuns: NodeRun[] }>>();
const getRun = vi.fn<(id: string) => Promise<RunDetail>>();

const gate = graphOf({ id: "g2", name: "Ship it", nodes: [{ id: "gate", type: "approval", label: "Review", position: { x: 0, y: 0 } }] });

describe("repo cache: pending approvals", () => {
  let cache: RepoCache;

  beforeEach(() => {
    pending.mockReset();
    getRun.mockReset();
    cache = createRepoCache("repo-0123abcd", { pending: () => pending(), getRun: (id: string) => getRun(id) } as unknown as RepoApi);
  });

  it("lists pending gates across runs, oldest first, with their graph and node labels", async () => {
    pending.mockResolvedValue({
      nodeRuns: [
        nodeRunOf({ id: "n2", nodeId: "gate", runId: "r2", status: "waiting_approval", updatedAt: 20 }),
        nodeRunOf({ id: "n1", nodeId: "gate", runId: "r1", status: "waiting_approval", updatedAt: 10 }),
      ],
    });
    getRun.mockImplementation(async (id) => runDetailOf(gate, [], id));
    await cache.getState().refreshPending();
    const s = cache.getState();
    expect(s.pending.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(s.pendingRuns.r1).toEqual({ graphId: "g2", graphName: "Ship it", shortId: "ab12", nodeLabels: { gate: "Review" } });
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it("fetches each run once and drops runs that are no longer pending", async () => {
    getRun.mockImplementation(async (id) => runDetailOf(gate, [], id));
    pending.mockResolvedValue({ nodeRuns: [nodeRunOf({ id: "n1", nodeId: "gate", runId: "r1", status: "waiting_approval" })] });
    await cache.getState().refreshPending();
    pending.mockResolvedValue({
      nodeRuns: [
        nodeRunOf({ id: "n1", nodeId: "gate", runId: "r1", status: "waiting_approval" }),
        nodeRunOf({ id: "n3", nodeId: "gate", runId: "r3", status: "waiting_approval" }),
      ],
    });
    await cache.getState().refreshPending();
    expect(getRun.mock.calls.map((c) => c[0])).toEqual(["r1", "r3"]);

    pending.mockResolvedValue({ nodeRuns: [] });
    await cache.getState().refreshPending();
    expect(cache.getState()).toMatchObject({ pending: [], pendingRuns: {} });
  });

  it("keeps the counter when a run cannot be fetched and on a failed refresh", async () => {
    pending.mockResolvedValue({ nodeRuns: [nodeRunOf({ id: "n1", nodeId: "gate", runId: "gone", status: "waiting_approval" })] });
    getRun.mockRejectedValue(new Error("404"));
    await cache.getState().refreshPending();
    expect(cache.getState().pending).toHaveLength(1);
    expect(cache.getState().pendingRuns).toEqual({});

    pending.mockRejectedValue(new Error("offline"));
    await cache.getState().refreshPending();
    expect(cache.getState().pending).toHaveLength(1);
  });
});

describe("repo cache: loading", () => {
  it("loads info and graphs once, and retries a failed load", async () => {
    const info = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ id: "repo-0123abcd", path: "/repo", name: "repo", currentBranch: "main", branches: [] });
    const listGraphs = vi.fn(async () => ({ graphs: [] }));
    const cache = createRepoCache("repo-0123abcd", { info, listGraphs, pending: async () => ({ nodeRuns: [] }) } as unknown as RepoApi);
    await cache.getState().load();
    expect(cache.getState().infoError).toMatchObject({ message: "down", status: null });
    await cache.getState().load();
    await cache.getState().load();
    expect(info).toHaveBeenCalledTimes(2);
    expect(cache.getState()).toMatchObject({ infoError: null, graphs: [] });
  });
});
