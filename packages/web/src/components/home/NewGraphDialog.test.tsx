// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Graph, LinearIssue, LinearStatusResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLocationProvider } from "../../lib/router/location";
import { REPO, installFakeDaemon, resetGlobals, type FakeDaemon } from "../../test-daemon";
import { LinearSettingsDialog } from "../settings/LinearSettingsDialog";
import { NewGraphDialog } from "./RepoDialogs";

const ISSUE: LinearIssue = {
  provider: "linear",
  id: "9c1a7e2e-0000-4000-8000-000000000001",
  identifier: "ENG-123",
  title: "Add Linear issues",
  url: "https://linear.app/acme/issue/ENG-123/add-linear-issues",
  branchName: "luis/eng-123-add-linear-issues",
  state: { name: "Todo", type: "unstarted", color: "#e2e2e2" },
  teamKey: "ENG",
};
const OTHER: LinearIssue = { ...ISSUE, id: "other", identifier: "ENG-7", title: "Another one", branchName: undefined };

/** The `states` query of the default filter (Backlog, Todo, In progress). */
const OPEN = `&states=${encodeURIComponent("triage,backlog,unstarted,started")}`;

const CONNECTED: LinearStatusResponse = { connected: true, viewer: { name: "Luis", email: null }, workspace: { name: "Acme", urlKey: "acme" }, error: null };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

let daemon: FakeDaemon;
let navigations: string[];
let closed: number;

function install(linear: { status: LinearStatusResponse; issues?: (q: string) => Response }) {
  daemon = installFakeDaemon({
    repos: { [REPO]: { info: { id: REPO, path: "/work/repo", name: "repo", currentBranch: "main", branches: ["main"] }, graphs: {}, runs: {} } },
    override: (method, path) => {
      if (path === "/api/linear") return json(200, linear.status);
      if (path.startsWith("/api/linear/issues")) {
        const q = new URL(path, "http://x").searchParams.get("q") ?? "";
        return linear.issues ? linear.issues(q) : json(200, { issues: q ? [ISSUE] : [ISSUE, OTHER] });
      }
      if (path === "/api/linear/key" && method === "PUT") return undefined;
      return undefined;
    },
  });
}

function renderDialog() {
  navigations = [];
  closed = 0;
  return render(
    <MemoryLocationProvider initialPath={`/r/${REPO}`} onNavigate={(p) => navigations.push(p)}>
      <NewGraphDialog repoId={REPO} onClose={() => closed++} />
    </MemoryLocationProvider>,
  );
}

const savedGraph = () => daemon.bodies.find((b) => b.call.startsWith(`PUT /api/repos/${REPO}/graphs/`))?.body as Graph | undefined;

beforeEach(() => resetGlobals());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NewGraphDialog with Linear (DESIGN §24)", () => {
  it("is a plain name field while Linear is not connected", async () => {
    install({ status: { connected: false, viewer: null, workspace: null, error: null } });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "New graph" });
    expect(await within(dialog).findByText(/Connect Linear in Settings/)).toBeTruthy();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Deploy it{Enter}");
    await waitFor(() => expect(navigations).toEqual([`/r/${REPO}/graphs/deploy-it`]));
    expect(savedGraph()).toMatchObject({ name: "Deploy it", settings: { branchPrefix: "" } });
    expect(savedGraph()?.issues).toBeUndefined();
    expect(daemon.calls.some((c) => c.includes("/api/linear/issues"))).toBe(false);
  });

  /** Opens the search dialog from the new-graph dialog; returns it. */
  async function openSearch(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /Link (Linear|more) issues/ }));
    return screen.findByRole("dialog", { name: "Link Linear issues" });
  }
  const results = (search: HTMLElement) => within(within(search).getByRole("listbox", { name: "Linear issues" }));

  it("links several issues through the search dialog: the name follows the first, the branch is the first one's", async () => {
    install({ status: CONNECTED });
    const user = userEvent.setup();
    renderDialog();
    const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
    const search = await openSearch(user);
    // An empty search lists my open issues.
    await waitFor(() => expect(results(search).getAllByRole("option")).toHaveLength(2));
    expect(daemon.calls).toContain(`GET /api/linear/issues?q=${OPEN}&scope=mine`);
    expect(within(search).getByRole("button", { name: "Add issue" }).hasAttribute("disabled")).toBe(true);

    await user.click(results(search).getByRole("option", { name: /ENG-123/ }));
    await user.click(results(search).getByRole("option", { name: /ENG-7/ }));
    expect(results(search).getByRole("option", { name: /ENG-7/ }).getAttribute("aria-selected")).toBe("true");
    expect(within(search).getByText("2 selected")).toBeTruthy();
    await user.click(within(search).getByRole("button", { name: "Add 2 issues" }));

    expect(screen.queryByRole("dialog", { name: "Link Linear issues" })).toBeNull();
    expect(name.value).toBe("ENG-123 Add Linear issues");
    const linked = screen.getByRole("list", { name: "Linked Linear issues" });
    expect(within(linked).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("ENG-123"), expect.stringContaining("ENG-7")]);

    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(navigations).toEqual([`/r/${REPO}/graphs/eng-123-add-linear-issues`]));
    const graph = savedGraph()!;
    expect(graph.issues?.map((i) => i.identifier)).toEqual(["ENG-123", "ENG-7"]);
    expect(graph.issues?.[0]).toEqual({
      provider: "linear",
      id: ISSUE.id,
      identifier: "ENG-123",
      title: "Add Linear issues",
      url: ISSUE.url,
      branchName: "luis/eng-123-add-linear-issues",
    });
    expect(graph.settings.branchPrefix).toBe("luis/eng-123-add-linear-issues");
  });

  it("Cancel discards the selection; Escape closes only the search dialog", async () => {
    install({ status: CONNECTED });
    const user = userEvent.setup();
    renderDialog();
    let search = await openSearch(user);
    await waitFor(() => expect(results(search).getAllByRole("option")).toHaveLength(2));
    await user.click(results(search).getByRole("option", { name: /ENG-7/ }));
    await user.click(within(search).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("list", { name: "Linked Linear issues" })).toBeNull();

    search = await openSearch(user);
    await waitFor(() => expect(results(search).getAllByRole("option")).toHaveLength(2));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link Linear issues" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "New graph" })).toBeTruthy();
    expect(closed).toBe(0);
  });

  it("searches with the keyboard, keeps a typed name, and shows linked issues as such when searching again", async () => {
    install({ status: CONNECTED });
    const user = userEvent.setup();
    renderDialog();
    const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
    await user.type(name, "Auth work");
    let search = await openSearch(user);
    const input = within(search).getByRole("searchbox", { name: "Search Linear issues" });
    await user.type(input, "eng-123");
    await waitFor(() => expect(daemon.calls).toContain(`GET /api/linear/issues?q=eng-123${OPEN}&scope=mine`));
    await waitFor(() => expect(results(search).getAllByRole("option")).toHaveLength(1));
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(results(search).getByRole("option").id);
    // Enter checks the highlighted result; Enter with none highlighted adds the selection.
    await user.keyboard("{Enter}{ArrowUp}");
    expect(within(search).getByRole("list", { name: "Selected issues" }).textContent).toContain("ENG-123");
    await user.click(within(search).getByRole("button", { name: "Add issue" }));
    expect(name.value).toBe("Auth work");

    search = await openSearch(user);
    await waitFor(() => expect(results(search).getAllByRole("option")).toHaveLength(2));
    const linkedOption = results(search).getByRole("option", { name: /ENG-123/ });
    expect(linkedOption.getAttribute("aria-disabled")).toBe("true");
    expect(within(linkedOption).getByText("Linked")).toBeTruthy();
    await user.click(linkedOption);
    expect(within(search).getByText("Nothing selected")).toBeTruthy();
    await user.click(within(search).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Unlink ENG-123" }));
    expect(screen.queryByRole("list", { name: "Linked Linear issues" })).toBeNull();
    expect(name.value).toBe("Auth work");
  });

  it("filters by scope and state, remembered per browser", async () => {
    install({ status: CONNECTED });
    const user = userEvent.setup();
    renderDialog();
    let search = await openSearch(user);
    const states = within(search).getByRole("toolbar", { name: "Issue states" });
    const pressed = () => within(states).getAllByRole("button", { pressed: true }).map((b) => b.textContent);
    expect(pressed()).toEqual(["Backlog", "Todo", "In progress"]);
    expect(within(search).getByRole("radio", { name: "My issues" }).getAttribute("aria-checked")).toBe("true");

    await user.type(within(search).getByRole("searchbox"), "login");
    await waitFor(() => expect(daemon.calls).toContain(`GET /api/linear/issues?q=login${OPEN}&scope=mine`));
    await user.click(within(states).getByRole("button", { name: "Done" }));
    await user.click(within(search).getByRole("radio", { name: "All issues" }));
    await waitFor(() =>
      expect(daemon.calls).toContain(`GET /api/linear/issues?q=login&states=${encodeURIComponent("triage,backlog,unstarted,started,completed")}&scope=all`),
    );

    // The last selected group cannot be turned off.
    for (const name of ["Backlog", "Todo", "In progress"]) await user.click(within(states).getByRole("button", { name }));
    await user.click(within(states).getByRole("button", { name: "Done" }));
    expect(pressed()).toEqual(["Done"]);
    expect(JSON.parse(localStorage.getItem("pg.linear.states")!)).toEqual(["done"]);
    expect(localStorage.getItem("pg.linear.scope")).toBe("all");

    await user.click(within(search).getByRole("button", { name: "Cancel" }));
    search = await openSearch(user);
    expect(within(within(search).getByRole("toolbar", { name: "Issue states" })).getAllByRole("button", { pressed: true }).map((b) => b.textContent)).toEqual(["Done"]);
    expect(within(search).getByRole("radio", { name: "All issues" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows why a search failed", async () => {
    install({ status: CONNECTED, issues: () => json(502, { error: "Linear rejected the API key", code: "linear_key_invalid" }) });
    const user = userEvent.setup();
    renderDialog();
    const search = await openSearch(user);
    expect((await within(search).findByRole("alert")).textContent).toMatch(/rejects the saved API key/);
  });
});

describe("LinearSettingsDialog (DESIGN §24)", () => {
  it("connects with a key, shows the workspace and disconnects", async () => {
    let status: LinearStatusResponse = { connected: false, viewer: null, workspace: null, error: null };
    daemon = installFakeDaemon({
      override: (method, path, body) => {
        if (path === "/api/linear") return json(200, status);
        if (path === "/api/linear/key" && method === "PUT") {
          if ((body as { apiKey: string }).apiKey !== "lin_api_good") return json(422, { error: "Linear rejected the API key", code: "linear_key_invalid" });
          status = CONNECTED;
          return json(200, status);
        }
        if (path === "/api/linear/key" && method === "DELETE") {
          status = { connected: false, viewer: null, workspace: null, error: null };
          return json(200, status);
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<LinearSettingsDialog onClose={() => undefined} />);
    const key = await screen.findByLabelText(/Personal API key/);
    expect(key.getAttribute("type")).toBe("password");
    await user.type(key, "lin_api_bad");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/rejected this key/);

    await user.clear(key);
    await user.type(key, "lin_api_good{Enter}");
    expect(await screen.findByText("Connected to Acme")).toBeTruthy();
    expect(screen.queryByLabelText(/Personal API key/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByLabelText(/Personal API key/)).toBeTruthy();
    expect(daemon.calls).toContain("DELETE /api/linear/key");
  });
});
