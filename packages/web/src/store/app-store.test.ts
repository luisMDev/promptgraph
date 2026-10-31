import type { NodeRun, RunDetail } from "@promptgraph/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { graphOf, nodeRunOf, runDetailOf } from "../test-fixtures";

const pending = vi.fn<() => Promise<{ nodeRuns: NodeRun[] }>>();
const getRun = vi.fn<(id: string) => Promise<RunDetail>>();

vi.mock("../api/rest", async (orig) => {
  const actual = await orig<typeof import("../api/rest")>();
  return { ...actual, api: { pending: () => pending(), getRun: (id: string) => getRun(id) } };
});

const { useAppStore } = await import("./app-store");

const gate = graphOf({ id: "g2", name: "Ship it", nodes: [{ id: "gate", type: "approval", label: "Review", position: { x: 0, y: 0 } }] });

describe("app store: pending approvals", () => {
  beforeEach(() => {
    pending.mockReset();
    getRun.mockReset();
    useAppStore.setState({ pending: [], pendingRuns: {} });
  });

  it("lists pending gates across runs, oldest first, with their graph and node labels", async () => {
    pending.mockResolvedValue({
      nodeRuns: [
        nodeRunOf({ id: "n2", nodeId: "gate", runId: "r2", status: "waiting_approval", updatedAt: 20 }),
        nodeRunOf({ id: "n1", nodeId: "gate", runId: "r1", status: "waiting_approval", updatedAt: 10 }),
      ],
    });
    getRun.mockImplementation(async (id) => runDetailOf(gate, [], id));
    await useAppStore.getState().refreshPending();
    const s = useAppStore.getState();
    expect(s.pending.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(s.pendingRuns.r1).toEqual({ graphId: "g2", graphName: "Ship it", shortId: "ab12", nodeLabels: { gate: "Review" } });
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it("fetches each run once and drops runs that are no longer pending", async () => {
    getRun.mockImplementation(async (id) => runDetailOf(gate, [], id));
    pending.mockResolvedValue({ nodeRuns: [nodeRunOf({ id: "n1", nodeId: "gate", runId: "r1", status: "waiting_approval" })] });
    await useAppStore.getState().refreshPending();
    pending.mockResolvedValue({
      nodeRuns: [
        nodeRunOf({ id: "n1", nodeId: "gate", runId: "r1", status: "waiting_approval" }),
        nodeRunOf({ id: "n3", nodeId: "gate", runId: "r3", status: "waiting_approval" }),
      ],
    });
    await useAppStore.getState().refreshPending();
    expect(getRun.mock.calls.map((c) => c[0])).toEqual(["r1", "r3"]);

    pending.mockResolvedValue({ nodeRuns: [] });
    await useAppStore.getState().refreshPending();
    expect(useAppStore.getState()).toMatchObject({ pending: [], pendingRuns: {} });
  });

  it("keeps the counter when a run cannot be fetched and on a failed refresh", async () => {
    pending.mockResolvedValue({ nodeRuns: [nodeRunOf({ id: "n1", nodeId: "gate", runId: "gone", status: "waiting_approval" })] });
    getRun.mockRejectedValue(new Error("404"));
    await useAppStore.getState().refreshPending();
    expect(useAppStore.getState().pending).toHaveLength(1);
    expect(useAppStore.getState().pendingRuns).toEqual({});

    pending.mockRejectedValue(new Error("offline"));
    await useAppStore.getState().refreshPending();
    expect(useAppStore.getState().pending).toHaveLength(1);
  });
});
