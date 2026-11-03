// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wsClient } from "./api/ws";
import { AppShell } from "./App";
import { MemoryLocationProvider, useLocation } from "./lib/router/location";
import { dispatcher } from "./store/live";
import { useDaemonStore } from "./store/daemon-store";
import { findEditorStore } from "./store/view/editor-store";
import { FakeSocket, REPO, installFakeDaemon, resetGlobals, summaryOf, type FakeDaemon } from "./test-daemon";
import { graphOf, linearGraph, nodeRunOf, runDetailOf } from "./test-fixtures";
import { RoutedView } from "./views/RoutedView";

// xterm needs a real canvas; the drawer's tabs are what these tests look at.
vi.mock("./components/terminal/TerminalView", () => ({ TerminalView: ({ ptyId }: { ptyId: string }) => <div data-testid={`terminal-${ptyId}`} /> }));

const graph = linearGraph();
const R = `/r/${REPO}`;

function fakeRepo(): FakeDaemon["repos"] {
  const detail = runDetailOf(graph, [nodeRunOf({ id: "na", nodeId: "a", status: "running", ptyId: "pty-na", activity: "Bash: pnpm test" })]);
  detail.run.status = "succeeded";
  detail.run.finishedAt = 2000;
  return {
    [REPO]: {
      info: { id: REPO, path: "/work/repo", name: "repo", currentBranch: "main", branches: ["main"] },
      graphs: {
        g1: { graph, hash: "h0", modifiedOutside: true, activeRunId: null },
        g2: { graph: graphOf({ id: "g2", name: "Second" }), hash: "h2", modifiedOutside: false, activeRunId: null },
      },
      runs: { r1: detail },
      reports: { r1: { run: { ...detail.run }, durationMs: 1000, nodes: [], lanes: [], prs: [], stalls: [] } },
    },
  };
}

function Where() {
  return <output data-testid="where">{useLocation().path}</output>;
}

function renderAt(path: string) {
  const navigations: { path: string; replace: boolean }[] = [];
  render(
    <MemoryLocationProvider initialPath={path} onNavigate={(p, o) => navigations.push({ path: p, replace: !!o?.replace })}>
      <AppShell>
        <RoutedView />
      </AppShell>
      <Where />
    </MemoryLocationProvider>,
  );
  return { navigations, where: () => screen.getByTestId("where").textContent };
}

let daemon: FakeDaemon;

beforeEach(() => {
  resetGlobals();
  vi.stubGlobal("WebSocket", FakeSocket);
  daemon = installFakeDaemon({ repos: fakeRepo(), summaries: [summaryOf()] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App routing (DESIGN §13.2)", () => {
  it("a graph route loads that graph, with its banners", async () => {
    renderAt(`${R}/graphs/g1`);
    expect(await screen.findByText("Implement")).toBeTruthy();
    expect(screen.getByText("Test")).toBeTruthy();
    expect(screen.getByText(/modified outside promptgraph/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Run$/ })).toBeTruthy();
    expect(daemon.calls).toContain(`GET /api/repos/${REPO}/graphs/g1`);
    await waitFor(() => expect(localStorage.getItem(`pg.lastGraph.${REPO}`)).toBe("g1"));
  });

  it("a run route shows the run and subscribes to it once; Back to editor navigates to its graph", async () => {
    const { where } = renderAt(`${R}/runs/r1`);
    expect(await screen.findByText("Bash: pnpm test")).toBeTruthy();
    expect(screen.getByText(/Viewing run #ab12/)).toBeTruthy();
    act(() => FakeSocket.last()!.open());
    const sent = FakeSocket.allSent();
    expect(sent.filter((m) => m.type === "subscribe")).toEqual([{ type: "subscribe", runId: "r1" }]);
    expect(sent.filter((m) => m.type === "repo:subscribe")).toEqual([{ type: "repo:subscribe", repoId: REPO }]);

    fireEvent.click(screen.getByRole("link", { name: "Back to editor" }));
    expect(where()).toBe(`${R}/graphs/g1`);
    expect(await screen.findByText("Graph settings")).toBeTruthy();
    expect(FakeSocket.allSent().filter((m) => m.type === "unsubscribe")).toEqual([{ type: "unsubscribe", runId: "r1" }]);
  });

  it("a node run route selects the node and opens its terminal", async () => {
    renderAt(`${R}/runs/r1/nodes/na`);
    expect(await screen.findByText("Implement · #ab12")).toBeTruthy();
    expect(await screen.findByTestId("terminal-pty-na")).toBeTruthy();
    // The inspector shows that node run.
    expect(screen.getAllByText("Implement").length).toBeGreaterThan(1);
  });

  it("clicking a node on the run canvas replaces the route with its node run", async () => {
    const { navigations } = renderAt(`${R}/runs/r1`);
    await screen.findByText("Bash: pnpm test");
    fireEvent.click(document.querySelector('.react-flow__node[data-id="a"]')!);
    expect(navigations.at(-1)).toEqual({ path: `${R}/runs/r1/nodes/na`, replace: true });
    expect(await screen.findByText("Implement · #ab12")).toBeTruthy();
  });

  it("clicking a pending node from a node run route goes to the run route and keeps that node selected", async () => {
    const { navigations } = renderAt(`${R}/runs/r1/nodes/na`);
    expect(await screen.findByText("Implement · #ab12")).toBeTruthy();
    fireEvent.click(document.querySelector('.react-flow__node[data-id="b"]')!);
    expect(navigations.at(-1)).toEqual({ path: `${R}/runs/r1`, replace: true });
    await waitFor(() => expect(screen.getByText("This node has not been scheduled yet.")).toBeTruthy());
    // Still selected once the route effect has run.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("This node has not been scheduled yet.")).toBeTruthy();
  });

  it("the report route shows the run report; closing it returns to the run", async () => {
    const { where } = renderAt(`${R}/runs/r1/report`);
    expect(await screen.findByRole("heading", { name: "Run report" })).toBeTruthy();
    await waitFor(() => expect(daemon.calls).toContain(`GET /api/repos/${REPO}/runs/r1/report`));
    fireEvent.click(screen.getByRole("link", { name: "Close report" }));
    expect(where()).toBe(`${R}/runs/r1`);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Run report" })).toBeNull());
  });

  it("an unknown repository, graph or run shows Not found with a link Home", async () => {
    renderAt("/r/unknown-00000000/graphs/g1");
    expect(await screen.findByText("Not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
    cleanup();

    renderAt(`${R}/graphs/nope`);
    expect(await screen.findByText("This graph does not exist.")).toBeTruthy();
    cleanup();

    renderAt(`${R}/runs/nope`);
    expect(await screen.findByText("This run does not exist in this repository.")).toBeTruthy();
    cleanup();

    renderAt("/settings");
    expect(await screen.findByText("Not found")).toBeTruthy();
  });

  it("/r/<repoId> redirects (replace) to the repository's last graph, else its first", async () => {
    localStorage.setItem(`pg.lastGraph.${REPO}`, "g2");
    const first = renderAt(R);
    await waitFor(() => expect(first.where()).toBe(`${R}/graphs/g2`));
    expect(first.navigations[0]).toEqual({ path: `${R}/graphs/g2`, replace: true });
    cleanup();

    localStorage.setItem(`pg.lastGraph.${REPO}`, "deleted-graph");
    const second = renderAt(R);
    await waitFor(() => expect(second.where()).toBe(`${R}/graphs/g1`));
  });

  it("an empty repository shows the editor's empty state", async () => {
    daemon.repos[REPO]!.graphs = {};
    renderAt(R);
    expect(await screen.findByText("No graphs in this repository yet.")).toBeTruthy();
  });

  it("the header's repository name links Home", async () => {
    const { where } = renderAt(`${R}/graphs/g1`);
    await screen.findByText("Implement");
    fireEvent.click(screen.getByRole("link", { name: "repo" }));
    expect(where()).toBe("/");
    expect(await screen.findByRole("heading", { name: "Repositories" })).toBeTruthy();
  });
});

describe("session, connection and version (DESIGN §13.5)", () => {
  it("shows Reconnecting… while the socket is down, and the version banner on a mismatch", async () => {
    renderAt(`${R}/graphs/g1`);
    await screen.findByText("Implement");
    act(() => useDaemonStore.getState().applyWsStatus({ connection: "reconnecting", signedOut: false, serverVersion: null, versionMismatch: false }));
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    act(() => useDaemonStore.getState().applyWsStatus({ connection: "unreachable", signedOut: false, serverVersion: null, versionMismatch: false }));
    expect(screen.getByText(/promptgraph is not reachable/)).toBeTruthy();
    act(() => useDaemonStore.getState().applyWsStatus({ connection: "open", signedOut: false, serverVersion: "0.2.0", versionMismatch: true }));
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(screen.getByText(/promptgraph was updated/)).toBeTruthy();
  });

  it("a repository removed while shown: Repository removed, then Add again reloads it", async () => {
    renderAt(`${R}/graphs/g1`);
    await screen.findByText("Implement");
    act(() => dispatcher.handle({ type: "repo:removed", repoId: REPO }));
    expect(await screen.findByText("Repository removed")).toBeTruthy();
    daemon.override = (method, path) => (method === "POST" && path === "/api/repos" ? new Response(JSON.stringify(summaryOf()), { status: 200 }) : undefined);
    fireEvent.click(screen.getByRole("button", { name: "Add again" }));
    expect(await screen.findByText("Implement")).toBeTruthy();
    expect(daemon.bodies.find((b) => b.call === "POST /api/repos")?.body).toEqual({ path: "/work/repo" });
  });

  it("a repository removed while disconnected is shown as removed after the reconnect", async () => {
    renderAt(`${R}/graphs/g1`);
    await screen.findByText("Implement");
    // The daemon forgot the repository and its repo:removed broadcast was missed.
    daemon.summaries = [];
    delete daemon.repos[REPO];
    act(() => {
      dispatcher.handle({ type: "hello", version: "0.1.0" });
      dispatcher.handle({ type: "hello", version: "0.1.0" });
    });
    expect(await screen.findByText("Repository removed")).toBeTruthy();
    expect(useDaemonStore.getState().removed[REPO]).toEqual({ id: REPO, path: "/work/repo", name: "repo" });
    expect(findEditorStore(REPO, "g1")).toBeUndefined();
  });

  // Last: signing out stops the page's socket for good (the rest of this file would be signed out too).
  it("a REST 401 shows the full-screen Signed out and stops the socket", async () => {
    daemon.override = (method, path) => (path === `/api/repos/${REPO}/graphs/g1` ? new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) : undefined);
    renderAt(`${R}/graphs/g1`);
    expect(await screen.findByText("Signed out")).toBeTruthy();
    expect(screen.getByText(/promptgraph open/)).toBeTruthy();
    expect(wsClient.status().signedOut).toBe(true);
  });
});
