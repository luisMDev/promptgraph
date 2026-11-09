// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphOf } from "../../test-fixtures";
import { createTestView } from "../../store/view/test-view";
import { resetLinearIssueStore } from "../../store/linear-issue-store";
import { resetLinearStore } from "../../store/linear-store";
import { Header } from "./Header";

const ISSUE = { provider: "linear", id: "id-9", identifier: "ENG-9", title: "Ship it", url: "https://linear.app/acme/issue/ENG-9" } as const;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  resetLinearStore();
  resetLinearIssueStore();
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/linear") return json({ connected: true, viewer: null, workspace: null, error: null });
    if (url.startsWith("/api/linear/issue-states")) return json({ issues: [{ ...ISSUE, state: { name: "In Review", type: "started", color: "#0f0" }, teamKey: "ENG" }] });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Header (DESIGN §24.3)", () => {
  it("shows the linked issue with its current state as a link to Linear", async () => {
    const view = createTestView({ graphId: "g1", graphs: [], path: "/r/repo-0123abcd/graphs/g1" });
    view.editor.setState({ graph: { ...graphOf({ id: "g1", name: "ENG-9 Ship it" }), issues: [ISSUE] }, loading: false, loadError: null, activeRunId: null });
    view.render(<Header />);
    const link = await screen.findByRole("link", { name: "ENG-9 in Linear: In Review" });
    expect(link.getAttribute("href")).toBe(ISSUE.url);
  });

  it("shows several issues compactly, the ones past the third behind +N", async () => {
    const issues = [1, 2, 3, 4].map((n) => ({ ...ISSUE, id: `id-${n}`, identifier: `ENG-${n}`, url: `https://linear.app/acme/issue/ENG-${n}` }));
    const view = createTestView({ graphId: "g1", graphs: [], path: "/r/repo-0123abcd/graphs/g1" });
    view.editor.setState({ graph: { ...graphOf({ id: "g1", name: "Several" }), issues }, loading: false, loadError: null, activeRunId: null });
    view.render(<Header />);
    const group = screen.getByLabelText("Linear issues");
    expect(screen.getAllByRole("link", { name: /^ENG-\d in Linear/ }).map((a) => a.getAttribute("href"))).toEqual(issues.slice(0, 3).map((i) => i.url));
    await userEvent.setup().click(screen.getByRole("button", { name: "1 more Linear issues" }));
    expect((await screen.findByRole("link", { name: /^ENG-4 in Linear/ })).getAttribute("href")).toBe(issues[3]!.url);
    expect(group).toBeTruthy();
  });

  it("shows nothing for a graph without an issue", () => {
    const view = createTestView({ graphId: "g1", graphs: [], path: "/r/repo-0123abcd/graphs/g1" });
    view.editor.setState({ graph: graphOf({ id: "g1", name: "Plain" }), loading: false, loadError: null, activeRunId: null });
    view.render(<Header />);
    expect(screen.queryByRole("link", { name: /in Linear/ })).toBeNull();
  });
});
