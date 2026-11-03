// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabContext, type TabContextValue } from "../components/tabs/tab-context";
import { MemoryLocationProvider } from "../lib/router/location";
import { useDaemonStore } from "../store/daemon-store";
import { dispatcher } from "../store/live";
import { REPO, daemonInfo, installFakeDaemon, resetGlobals, summaryOf, type FakeDaemon } from "../test-daemon";
import { HomeView } from "./HomeView";

const OTHER = "other-0000beef";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

let daemon: FakeDaemon;
let navigations: string[];

function renderHome() {
  navigations = [];
  render(
    <MemoryLocationProvider initialPath="/" onNavigate={(p) => navigations.push(p)}>
      <HomeView />
    </MemoryLocationProvider>,
  );
}

beforeEach(async () => {
  resetGlobals();
  daemon = installFakeDaemon({
    summaries: [
      summaryOf({ lastRunAt: Date.UTC(2026, 0, 2), runs: { running: 1, paused: 0 }, waiting: { approval: 2, input: 1 } }),
      summaryOf({ id: OTHER, name: "other", path: "/gone/other", available: false, error: "ENOENT: the directory is gone", lastOpenedAt: 1 }),
    ],
  });
  useDaemonStore.setState({ info: { ...daemonInfo, warnings: ["gh is not installed: pr nodes cannot run"] } });
  await useDaemonStore.getState().loadRepos();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HomeView (DESIGN §13.3)", () => {
  it("lists every repository with availability, counters, error and last run, plus daemon version and warnings", async () => {
    renderHome();
    const row = screen.getByRole("listitem", { name: "repo" });
    expect(within(row).getByText("/work/repo")).toBeTruthy();
    expect(within(row).getByText("1 running")).toBeTruthy();
    expect(within(row).getByText("2 awaiting approval")).toBeTruthy();
    expect(within(row).getByText("1 waiting for input")).toBeTruthy();
    expect(within(row).getByText(/^Last run /)).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Open repo" }).getAttribute("href")).toBe(`/r/${REPO}`);

    const other = screen.getByRole("listitem", { name: "other" });
    expect(within(other).getByText("unavailable")).toBeTruthy();
    expect(within(other).getByText("ENOENT: the directory is gone")).toBeTruthy();
    expect(within(other).getByText("No runs yet")).toBeTruthy();

    expect(screen.getByText("v0.1.0")).toBeTruthy();
    expect(screen.getByText("gh is not installed: pr nodes cannot run")).toBeTruthy();
  });

  it("links to the graphs and active runs of available repositories, loaded with GETs only", async () => {
    daemon.repos[REPO] = {
      info: { id: REPO, path: "/work/repo", name: "repo", currentBranch: "main", branches: [] },
      graphs: { g1: { graph: { version: 1, id: "g1", name: "Ship it", nodes: [], edges: [], settings: {} } as never, hash: "h", modifiedOutside: false, activeRunId: null } },
      runs: {},
    };
    renderHome();
    const row = screen.getByRole("listitem", { name: "repo" });
    expect((await within(row).findByRole("link", { name: /Ship it/ })).getAttribute("href")).toBe(`/r/${REPO}/graphs/g1`);
    expect(daemon.calls.filter((c) => c.startsWith(`GET /api/repos/${REPO}/`)).length).toBeGreaterThan(0);
    expect(daemon.calls.some((c) => !c.startsWith("GET "))).toBe(false);
  });

  it("refetches the graph links when its tab becomes visible again and after a reconnect, never while hidden", async () => {
    const graphOf = (id: string, name: string) => ({ graph: { version: 1, id, name, nodes: [], edges: [], settings: {} } as never, hash: "h", modifiedOutside: false, activeRunId: null });
    daemon.repos[REPO] = { info: { id: REPO, path: "/work/repo", name: "repo", currentBranch: "main", branches: [] }, graphs: { g1: graphOf("g1", "Ship it") }, runs: {} };
    const tab = (active: boolean): TabContextValue => ({ tabId: "t", active, setTitle: () => undefined, close: () => undefined, reportEditor: () => undefined });
    const ui = (active: boolean) => (
      <MemoryLocationProvider initialPath="/">
        <TabContext.Provider value={tab(active)}>
          <HomeView />
        </TabContext.Provider>
      </MemoryLocationProvider>
    );
    const graphCalls = () => daemon.calls.filter((c) => c === `GET /api/repos/${REPO}/graphs`).length;
    const view = render(ui(true));
    const row = () => screen.getByRole("listitem", { name: "repo" });
    await within(row()).findByRole("link", { name: /Ship it/ });

    // Created elsewhere while Home is hidden: nothing is fetched until it is shown again.
    daemon.repos[REPO].graphs.g2 = graphOf("g2", "Second graph");
    const before = graphCalls();
    view.rerender(ui(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(graphCalls()).toBe(before);
    view.rerender(ui(true));
    await within(row()).findByRole("link", { name: /Second graph/ });

    daemon.repos[REPO].graphs.g3 = graphOf("g3", "Third graph");
    act(() => useDaemonStore.setState({ connection: "reconnecting" }));
    act(() => useDaemonStore.setState({ connection: "open" }));
    await within(row()).findByRole("link", { name: /Third graph/ });
  });

  it("adds a repository by absolute path and opens it; both 422s are explained", async () => {
    daemon.override = (method, _path, body) => {
      if (method !== "POST") return undefined;
      const path = (body as { path: string }).path;
      if (path === "relative/dir") return json(422, { error: "Path must be absolute", code: "path_not_absolute" });
      if (path === "/tmp") return json(422, { error: "Not a git repository", code: "not_a_git_repo" });
      return json(200, summaryOf({ id: "new-0000cafe", name: "new", path: "/work/new" }));
    };
    renderHome();
    expect(screen.getByText(/graphs in a repository can run commands/i)).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Repository path" });
    const add = screen.getByRole("button", { name: /Add/ });

    fireEvent.change(input, { target: { value: "relative/dir" } });
    fireEvent.click(add);
    expect(await screen.findByText(/Enter an absolute path/)).toBeTruthy();

    fireEvent.change(input, { target: { value: "/tmp" } });
    fireEvent.click(add);
    expect(await screen.findByText(/not inside a git repository/)).toBeTruthy();

    fireEvent.change(input, { target: { value: "~/new" } });
    fireEvent.click(add);
    await waitFor(() => expect(navigations).toEqual(["/r/new-0000cafe"]));
    expect(useDaemonStore.getState().repos?.map((r) => r.id)).toContain("new-0000cafe");
  });

  it("removes a repository after confirmation; a 409 offers Remove anyway (force)", async () => {
    daemon.override = (method, path) => {
      if (method !== "DELETE") return undefined;
      return path.endsWith("?force=1") ? json(200, { ok: true }) : json(409, { error: "A run is active", code: "repo_active" });
    };
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Remove repo" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove repo" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText(/A run of this repository is active/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove anyway" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "repo" })).toBeNull());
    expect(daemon.calls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE /api/repos/${REPO}`, `DELETE /api/repos/${REPO}?force=1`]);
  });

  it("updates live from repo:status and repo:removed", async () => {
    renderHome();
    const row = screen.getByRole("listitem", { name: "repo" });
    act(() => dispatcher.handle({ type: "repo:status", repo: summaryOf({ runs: { running: 0, paused: 1 }, waiting: { approval: 0, input: 0 } }) }));
    expect(within(row).getByText("1 paused")).toBeTruthy();
    expect(within(row).queryByText("1 running")).toBeNull();

    act(() => dispatcher.handle({ type: "repo:removed", repoId: OTHER }));
    expect(screen.queryByRole("listitem", { name: "other" })).toBeNull();
    expect(useDaemonStore.getState().removed[OTHER]).toEqual({ id: OTHER, path: "/gone/other", name: "other" });
  });
});
