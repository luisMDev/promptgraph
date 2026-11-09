// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLocationProvider } from "../../lib/router/location";
import { useDaemonStore } from "../../store/daemon-store";
import { dispatcher } from "../../store/live";
import { REPO, daemonInfo, installFakeDaemon, resetGlobals, summaryOf, type FakeDaemon } from "../../test-daemon";
import { graphOf, linearGraph, runDetailOf } from "../../test-fixtures";
import { TabContext, type TabContextValue } from "../tabs/tab-context";
import { Overview } from "./Overview";
import { groupItems, type OverviewItem } from "./data";
import { useOverviewQuery } from "./parts";
import { reloadSidebarPrefs, useSidebarPrefs } from "./RepoSidebar";

const SECOND = "second-0000cafe";
const OTHER = "other-0000beef";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

const loaded = (id: string, name: string) => ({ graph: graphOf({ id, name }), hash: `h-${id}`, modifiedOutside: false, activeRunId: null });

let daemon: FakeDaemon;
let navigations: string[];

function tab(active: boolean): TabContextValue {
  return {
    tabId: "t",
    active,
    setTitle: () => undefined,
    setGraph: () => undefined,
    close: () => undefined,
    reportEditor: () => undefined,
    chats: null,
    setChats: () => undefined,
    bottomBar: null,
    bottomBarStart: null,
  };
}

function ui(repoId: string | null, active = true) {
  return (
    <MemoryLocationProvider initialPath={repoId ? `/r/${repoId}` : "/"} onNavigate={(p) => navigations.push(p)}>
      <TabContext.Provider value={tab(active)}>
        <Overview repoId={repoId} />
      </TabContext.Provider>
    </MemoryLocationProvider>
  );
}

function renderOverview(repoId: string | null = null) {
  navigations = [];
  return render(ui(repoId));
}

const sidebar = () => screen.getByRole("complementary", { name: "Repositories" });
const graphs = () => screen.getByRole("region", { name: "Graphs" });

beforeEach(async () => {
  resetGlobals();
  useOverviewQuery.setState({ query: "" });
  reloadSidebarPrefs();
  const run = runDetailOf(linearGraph(), []);
  daemon = installFakeDaemon({
    repos: {
      [REPO]: { info: { id: REPO, path: "/work/repo", name: "repo", currentBranch: "main", branches: ["main"] }, graphs: { g1: { ...loaded("g1", "Ship it"), graph: linearGraph() }, g2: loaded("g2", "Release") }, runs: { r1: run } },
      [SECOND]: { info: { id: SECOND, path: "/work/second", name: "second", currentBranch: "dev", branches: ["dev"] }, graphs: { s1: loaded("s1", "Nightly") }, runs: {} },
    },
    summaries: [
      summaryOf({ lastRunAt: Date.UTC(2026, 0, 2), runs: { running: 1, paused: 0 }, waiting: { approval: 2, input: 1 } }),
      summaryOf({ id: SECOND, name: "second", path: "/work/second" }),
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

describe("Overview (DESIGN §13.3)", () => {
  it("shows every graph of every available repository as cards, with the repositories as the filter, loaded with GETs only", async () => {
    renderOverview();
    const card = await within(graphs()).findByRole("listitem", { name: "Graph 1" });
    expect(within(card).getByRole("link", { name: "Open Graph 1" }).getAttribute("href")).toBe(`/r/${REPO}/graphs/g1`);
    expect(within(card).getByRole("img", { name: "2 steps" })).toBeTruthy();
    expect(within(card).getByText(/1 run\b/)).toBeTruthy();
    expect(within(graphs()).getByRole("listitem", { name: "Nightly" })).toBeTruthy();
    expect(within(graphs()).getByRole("listitem", { name: "Release" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All graphs" })).toBeTruthy();
    expect(screen.getByText("gh is not installed: pr nodes cannot run")).toBeTruthy();

    const all = within(sidebar()).getByRole("link", { name: /All graphs/ });
    expect(all.getAttribute("href")).toBe("/");
    expect(all.getAttribute("aria-current")).toBe("page");
    expect(within(sidebar()).getByRole("link", { name: /^repo/ }).getAttribute("href")).toBe(`/r/${REPO}`);
    expect(within(sidebar()).getByRole("link", { name: /second/ }).closest("li")?.textContent).toContain("1");
    // The unavailable repository is listed but never fetched.
    expect(within(sidebar()).getByRole("link", { name: /other/ })).toBeTruthy();
    expect(daemon.calls.some((c) => c.includes(OTHER))).toBe(false);
    expect(daemon.calls.some((c) => !c.startsWith("GET "))).toBe(false);
  });

  it("filtered to one repository: its graphs, its name, path and counters, and Remove", async () => {
    renderOverview(REPO);
    await within(graphs()).findByRole("listitem", { name: "Graph 1" });
    expect(within(graphs()).queryByRole("listitem", { name: "Nightly" })).toBeNull();
    expect(screen.getByRole("heading", { name: "repo" })).toBeTruthy();
    expect(screen.getByText("/work/repo")).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
    expect(screen.getByText("2 awaiting approval")).toBeTruthy();
    expect(within(sidebar()).getByRole("link", { name: /^repo/ }).getAttribute("aria-current")).toBe("page");
    // Inside one repository the graphs are not grouped: no Group by, no group headings.
    expect(screen.queryByRole("radiogroup", { name: "Group by" })).toBeNull();
    expect(within(graphs()).queryByRole("heading")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove repo" })).toBeTruthy();
  });

  it("searches graph and repository names, and groups by repository", async () => {
    renderOverview();
    await within(graphs()).findByRole("listitem", { name: "Nightly" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search graphs" }), { target: { value: "second" } });
    expect(within(graphs()).getByRole("listitem", { name: "Nightly" })).toBeTruthy();
    expect(within(graphs()).queryByRole("listitem", { name: "Graph 1" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search graphs" }), { target: { value: "zzz" } });
    expect(screen.getByText("No graph matches “zzz”")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search graphs" }), { target: { value: "" } });

    fireEvent.click(screen.getByRole("radio", { name: "Repository" }));
    expect(within(graphs()).getByRole("heading", { name: /^repo/ })).toBeTruthy();
    expect(within(graphs()).getByRole("heading", { name: /^second/ })).toBeTruthy();
    expect(localStorage.getItem("pg.overview.group")).toBe("repo");
  });

  it("refetches when its tab becomes visible again and after a reconnect, never while hidden", async () => {
    navigations = [];
    const view = render(ui(null));
    await within(graphs()).findByRole("listitem", { name: "Graph 1" });
    const calls = () => daemon.calls.filter((c) => c === `GET /api/repos/${REPO}/graph-overviews`).length;

    daemon.repos[REPO]!.graphs.g3 = loaded("g3", "Third");
    const before = calls();
    view.rerender(ui(null, false));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls()).toBe(before);
    view.rerender(ui(null, true));
    expect(await within(graphs()).findByRole("listitem", { name: "Third" })).toBeTruthy();

    daemon.repos[REPO]!.graphs.g4 = loaded("g4", "Fourth");
    act(() => useDaemonStore.setState({ connection: "reconnecting" }));
    act(() => useDaemonStore.setState({ connection: "open" }));
    expect(await within(graphs()).findByRole("listitem", { name: "Fourth" })).toBeTruthy();
  });

  it("adds a repository from its dialog and opens it; both 422s are explained", async () => {
    daemon.override = (method, _path, body) => {
      if (method !== "POST") return undefined;
      const path = (body as { path: string }).path;
      if (path === "relative/dir") return json(422, { error: "Path must be absolute", code: "path_not_absolute" });
      if (path === "/tmp") return json(422, { error: "Not a git repository", code: "not_a_git_repo" });
      return json(200, summaryOf({ id: "new-0000cafe", name: "new", path: "/work/new" }));
    };
    renderOverview();
    fireEvent.click(within(sidebar()).getByRole("button", { name: /Add repository/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a repository" });
    expect(within(dialog).getByText(/graphs in a repository can run commands/i)).toBeTruthy();
    const input = within(dialog).getByRole("combobox", { name: "Repository path" });
    const add = within(dialog).getByRole("button", { name: /^Add$/ });

    fireEvent.change(input, { target: { value: "relative/dir" } });
    fireEvent.click(add);
    expect(await within(dialog).findByText(/Enter an absolute path/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "/tmp" } });
    fireEvent.click(add);
    expect(await within(dialog).findByText(/not inside a git repository/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "~/new" } });
    fireEvent.click(add);
    await waitFor(() => expect(navigations).toEqual(["/r/new-0000cafe"]));
    expect(useDaemonStore.getState().repos?.map((r) => r.id)).toContain("new-0000cafe");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a repository" })).toBeNull());
  });

  it("suggests subfolders while typing; Tab and Enter complete the highlighted one", async () => {
    const dirs: Record<string, { name: string; isGitRepo: boolean }[]> = {
      "~/": [
        { name: "Projects", isGitRepo: false },
        { name: "pics", isGitRepo: false },
        { name: "notes", isGitRepo: true },
      ],
      "~/Projects/": [
        { name: "alpha", isGitRepo: true },
        { name: "beta", isGitRepo: false },
      ],
    };
    daemon.override = (method, path) => {
      if (method !== "GET" || !path.startsWith("/api/fs/dirs")) return undefined;
      const dir = new URL(path, "http://x").searchParams.get("path") ?? "";
      const entries = (dirs[dir] ?? []).map((e) => ({ ...e, path: `/home/you/${e.name}` }));
      return json(200, { path: dir, parent: "/home", home: "/home/you", isGitRepo: false, entries });
    };
    renderOverview();
    fireEvent.click(within(sidebar()).getByRole("button", { name: /Add repository/ }));
    const input = await screen.findByRole("combobox", { name: "Repository path" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "~/p" } });
    const list = await screen.findByRole("listbox", { name: "Folder suggestions" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Projects", "pics"]);

    fireEvent.keyDown(input, { key: "Tab" });
    expect((input as HTMLInputElement).value).toBe("~/Projects/");
    const next = await screen.findByRole("listbox", { name: "Folder suggestions" });
    await within(next).findByText("alpha");
    expect(within(next).getByText("git")).toBeTruthy();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((input as HTMLInputElement).value).toBe("~/Projects/beta/");
    expect(daemon.calls.some((c) => !c.startsWith("GET "))).toBe(false);
  });

  it("browses folders in a dialog and adds the chosen one", async () => {
    const tree: Record<string, { name: string; isGitRepo: boolean }[]> = {
      "/home/you": [{ name: "work", isGitRepo: false }],
      "/home/you/work": [{ name: "new", isGitRepo: true }],
      "/home/you/work/new": [{ name: "src", isGitRepo: false }],
    };
    daemon.override = (method, path, body) => {
      if (method === "POST" && path === "/api/repos") {
        expect(body).toEqual({ path: "/home/you/work/new" });
        return json(200, summaryOf({ id: "new-0000cafe", name: "new", path: "/home/you/work/new" }));
      }
      if (method !== "GET" || !path.startsWith("/api/fs/dirs")) return undefined;
      const dir = new URL(path, "http://x").searchParams.get("path") ?? "/home/you";
      if (!tree[dir]) return json(404, { error: `Not a directory: ${dir}`, code: "not_a_directory" });
      const entries = tree[dir].map((e) => ({ ...e, path: `${dir}/${e.name}` }));
      return json(200, { path: dir, parent: dir === "/" ? null : dir.slice(0, dir.lastIndexOf("/")) || "/", home: "/home/you", isGitRepo: dir.endsWith("/new"), entries });
    };
    renderOverview();
    fireEvent.click(within(sidebar()).getByRole("button", { name: /Add repository/ }));
    const add = await screen.findByRole("dialog", { name: "Add a repository" });
    // A typed path that is not a directory falls back to home.
    fireEvent.change(within(add).getByRole("combobox", { name: "Repository path" }), { target: { value: "/nope/x" } });
    fireEvent.click(within(add).getByRole("button", { name: /Browse/ }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a repository folder" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /work/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: /new/ }));
    expect(await within(dialog).findByText("This folder is a git repository.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add this folder" }));
    await waitFor(() => expect(navigations).toEqual(["/r/new-0000cafe"]));
  });

  it("removes a repository after confirmation; a 409 offers Remove anyway (force)", async () => {
    daemon.override = (method, path) => {
      if (method !== "DELETE") return undefined;
      return path.endsWith("?force=1") ? json(200, { ok: true }) : json(409, { error: "A run is active", code: "repo_active" });
    };
    renderOverview(REPO);
    fireEvent.click(screen.getByRole("button", { name: "Remove repo" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove repo" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText(/A run of this repository is active/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove anyway" }));
    await waitFor(() => expect(within(sidebar()).queryByRole("link", { name: /^repo/ })).toBeNull());
    expect(daemon.calls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE /api/repos/${REPO}`, `DELETE /api/repos/${REPO}?force=1`]);
  });

  it("updates live from repo:status and repo:removed", async () => {
    renderOverview(REPO);
    await within(graphs()).findByRole("listitem", { name: "Graph 1" });
    act(() => dispatcher.handle({ type: "repo:status", repo: summaryOf({ runs: { running: 0, paused: 1 }, waiting: { approval: 0, input: 0 } }) }));
    expect(screen.getByText("1 paused")).toBeTruthy();
    expect(screen.queryByText("1 running")).toBeNull();

    act(() => dispatcher.handle({ type: "repo:removed", repoId: OTHER }));
    expect(within(sidebar()).queryByRole("link", { name: /other/ })).toBeNull();
    expect(useDaemonStore.getState().removed[OTHER]).toEqual({ id: OTHER, path: "/gone/other", name: "other" });
  });

  it("creates a graph in the chosen repository on its current branch and opens it", async () => {
    renderOverview();
    await within(graphs()).findByRole("listitem", { name: "Nightly" });
    fireEvent.click(screen.getByRole("button", { name: /New graph/ }));
    const dialog = await screen.findByRole("dialog", { name: "New graph" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: SECOND } });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Deploy it" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(navigations).toEqual([`/r/${SECOND}/graphs/deploy-it`]));
    const saved = daemon.bodies.find((b) => b.call === `PUT /api/repos/${SECOND}/graphs/deploy-it`)?.body as { name: string; settings: { baseBranch: string } };
    expect(saved).toMatchObject({ name: "Deploy it", settings: { baseBranch: "dev" } });
  });

  it("deletes a graph from its card after confirmation", async () => {
    renderOverview();
    const card = await within(graphs()).findByRole("listitem", { name: "Release" });
    fireEvent.click(within(card).getByRole("button", { name: "Delete Release" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete graph" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(daemon.calls).toContain(`DELETE /api/repos/${REPO}/graphs/g2`));
    await waitFor(() => expect(within(graphs()).queryByRole("listitem", { name: "Release" })).toBeNull());
  });

  it("stars a repository into Favorites, above Repositories, and back", async () => {
    renderOverview();
    const repos = () => within(sidebar()).getByRole("list", { name: "Repositories" });
    expect(within(sidebar()).queryByRole("list", { name: "Favorites" })).toBeNull();
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Add second to favorites" }));
    const favorites = within(sidebar()).getByRole("list", { name: "Favorites" });
    expect(within(favorites).getByRole("link", { name: /second/ })).toBeTruthy();
    expect(within(repos()).queryByRole("link", { name: /second/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem("pg.overview.sidebar.favorites")!)).toEqual([SECOND]);
    // Favorites come first in the column.
    const lists = within(sidebar()).getAllByRole("list").map((l) => l.getAttribute("aria-label"));
    expect(lists).toEqual(["Favorites", "Repositories"]);

    fireEvent.click(within(favorites).getByRole("button", { name: "Remove second from favorites" }));
    expect(within(sidebar()).queryByRole("list", { name: "Favorites" })).toBeNull();
    expect(within(repos()).getByRole("link", { name: /second/ })).toBeTruthy();
  });

  it("reorders repositories with Alt+↑/↓ and remembers the order", async () => {
    renderOverview();
    const order = () => within(within(sidebar()).getByRole("list", { name: "Repositories" })).getAllByRole("link").map((a) => a.querySelector(".truncate")?.textContent);
    expect(order()).toEqual(["repo", "second", "other"]);
    fireEvent.keyDown(within(sidebar()).getByRole("link", { name: /other/ }), { key: "ArrowUp", altKey: true });
    expect(order()).toEqual(["repo", "other", "second"]);
    fireEvent.keyDown(within(sidebar()).getByRole("link", { name: /^r?repo/ }), { key: "ArrowDown", altKey: true });
    expect(order()).toEqual(["other", "repo", "second"]);
    expect(JSON.parse(localStorage.getItem("pg.overview.sidebar.order")!)).toEqual([OTHER, REPO, SECOND]);
    // Without Alt the arrows do nothing here.
    fireEvent.keyDown(within(sidebar()).getByRole("link", { name: /other/ }), { key: "ArrowDown" });
    expect(order()).toEqual(["other", "repo", "second"]);
  });

  it("resizes the column from its edge (keyboard), within bounds, and remembers the width", async () => {
    renderOverview();
    const handle = screen.getByRole("separator", { name: "Resize repositories" });
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    expect(localStorage.getItem("pg.overview.sidebar.width")).toBe("256");
    for (let i = 0; i < 30; i++) fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useSidebarPrefs.getState().width).toBe(180);
    fireEvent.doubleClick(handle);
    expect(useSidebarPrefs.getState().width).toBe(240);
  });

  it("welcomes a fresh profile with the Add repository form", async () => {
    daemon.summaries.splice(0);
    await useDaemonStore.getState().loadRepos();
    renderOverview();
    expect(screen.getByRole("heading", { name: "Welcome to promptgraph" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Repository path" })).toBeTruthy();
  });
});

describe("groupItems", () => {
  const item = (repoId: string, activity: number): OverviewItem => ({
    key: `${repoId}/${activity}`,
    repo: summaryOf({ id: repoId, name: repoId }),
    graph: { id: String(activity), name: null, loadError: null, updatedAt: activity, hash: "h", preview: null, runs: { total: 0, active: 0, costUsd: 0, lastRun: null } },
    activity,
    lastOpened: false,
  });
  const now = new Date(2026, 5, 15, 12).getTime();
  const day = 24 * 60 * 60 * 1000;

  it("buckets by recency, newest bucket first", () => {
    const items = [item("a", now - 1000), item("a", now - day), item("b", now - 3 * day), item("b", now - 20 * day), item("a", now - 90 * day)];
    expect(groupItems(items, "recent", [], now).map((g) => [g.label, g.items.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 1],
      ["Previous 7 days", 1],
      ["Previous 30 days", 1],
      ["Older", 1],
    ]);
  });

  it("groups by repository in the repositories' order, skipping empty ones", () => {
    const repos = [summaryOf({ id: "b", name: "b" }), summaryOf({ id: "c", name: "c" }), summaryOf({ id: "a", name: "a" })];
    const groups = groupItems([item("a", 2), item("b", 1)], "repo", repos, now);
    expect(groups.map((g) => g.label)).toEqual(["b", "a"]);
  });
});
