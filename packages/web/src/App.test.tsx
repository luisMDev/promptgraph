// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RepoInfoResponse } from "@promptgraph/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { linearGraph, nodeRunOf, runDetailOf } from "./test-fixtures";

const graph = linearGraph();
const repo: RepoInfoResponse = { path: "/repo", name: "repo", currentBranch: "main", branches: ["main"], version: "0.1.0", phase: 1, warnings: [], supportedNodeTypes: ["prompt", "command", "shell", "commit"], notificationsAvailable: true };

vi.mock("./api/rest", async (orig) => {
  const actual = await orig<typeof import("./api/rest")>();
  return {
    ...actual,
    api: {
      repo: async () => repo,
      getSettings: async () => ({ notifications: true }),
      listGraphs: async () => ({ graphs: [{ id: "g1", name: "Graph 1", loadError: null, updatedAt: 1, hash: "h0" }] }),
      getGraph: async () => ({ graph, hash: "h0", modifiedOutside: true, activeRunId: null }),
      saveGraph: async (g: typeof graph) => ({ graph: g, hash: "h1" }),
      listRuns: async () => ({ runs: [] }),
      pending: async () => ({ nodeRuns: [] }),
      commands: async () => ({ commands: [] }),
      getRun: async () => runDetailOf(graph, [nodeRunOf({ id: "na", nodeId: "a", status: "running", activity: "Bash: pnpm test" })]),
    },
  };
});

class StubSocket {
  static OPEN = 1;
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  send() {}
  close() {}
}

beforeAll(() => {
  vi.stubGlobal("WebSocket", StubSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(cleanup);

describe("App (smoke)", () => {
  it("boots, opens the last graph, shows nodes, the modified-outside banner and run mode", async () => {
    const { App } = await import("./App");
    render(<App />);
    expect(await screen.findByText("Implement")).toBeTruthy();
    expect(screen.getByText("Test")).toBeTruthy();
    expect(screen.getByText(/modified outside promptgraph/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Run$/ })).toBeTruthy();

    const { useRunStore } = await import("./store/run-store");
    await act(() => useRunStore.getState().selectRun("r1"));
    expect(await screen.findByText("Bash: pnpm test")).toBeTruthy();
    expect(screen.getByText(/Viewing run #ab12/)).toBeTruthy();

    fireEvent.click(screen.getByText("Back to editor"));
    expect(await screen.findByText("Graph settings")).toBeTruthy();
  });
});
