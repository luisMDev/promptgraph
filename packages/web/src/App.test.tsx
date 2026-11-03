// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RepoInfoResponse } from "@promptgraph/shared";
import userEvent from "@testing-library/user-event";
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

  it("switches the left panel with the tabs and collapses it from inside the sidebar", async () => {
    const { useRunStore } = await import("./store/run-store");
    const { useUiStore } = await import("./store/ui-store");
    await act(() => useRunStore.getState().selectRun(null));
    act(() => useUiStore.getState().setLeftPanel("palette"));
    const user = userEvent.setup();
    const { App } = await import("./App");
    const { container } = render(<App />);
    await screen.findByText("Implement");

    const runsTab = screen.getByRole("tab", { name: /^Runs/ });
    expect(screen.getByRole("tab", { name: "Nodes" }).getAttribute("aria-selected")).toBe("true");
    await user.click(runsTab);
    expect(runsTab.getAttribute("aria-selected")).toBe("true");
    expect(useUiStore.getState().leftPanel).toBe("history");
    expect(screen.getByRole("tabpanel").textContent).toContain("No runs yet.");

    const sidebar = container.querySelector('[data-slot="sidebar"]');
    const panel = container.querySelector('[data-slot="sidebar-container"]');
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(sidebar?.getAttribute("data-state")).toBe("expanded");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.contains(collapse)).toBe(true);
    expect(panel?.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();

    await user.click(collapse);
    expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
    // Collapsed off-canvas: out of the Tab order and the accessibility tree; the canvas offers the expand button.
    expect(panel?.hasAttribute("inert")).toBe(true);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");

    await user.click(expand);
    expect(sidebar?.getAttribute("data-state")).toBe("expanded");
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();

    // Asking for a panel (e.g. "Open run history…" in the run menu) re-expands a collapsed sidebar.
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
    act(() => useUiStore.getState().setLeftPanel("history"));
    expect(sidebar?.getAttribute("data-state")).toBe("expanded");
    expect(panel?.hasAttribute("inert")).toBe(false);
  });
});
