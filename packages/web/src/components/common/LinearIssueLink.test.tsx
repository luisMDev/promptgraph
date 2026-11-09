// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { LinearIssue, LinearStatusResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDaemon, resetGlobals, type FakeDaemon } from "../../test-daemon";
import { resetLinearIssueStore } from "../../store/linear-issue-store";
import { LinearIssueLink, type IssueRef } from "./LinearIssueLink";

const CONNECTED: LinearStatusResponse = { connected: true, viewer: { name: "Luis", email: null }, workspace: { name: "Acme", urlKey: "acme" }, error: null };

const A: IssueRef = { id: "id-a", identifier: "ENG-1", title: "Old title", url: "https://linear.app/acme/issue/ENG-1" };
const B: IssueRef = { id: "id-b", identifier: "ENG-2", title: "Second", url: "https://linear.app/acme/issue/ENG-2" };
const LIVE_A: LinearIssue = { ...A, provider: "linear", title: "New title", state: { name: "In Progress", type: "started", color: "#f2c94c" }, teamKey: "ENG" };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

let daemon: FakeDaemon;
let clock: number;

function install(status: LinearStatusResponse, states: () => Response = () => json(200, { issues: [LIVE_A] })) {
  daemon = installFakeDaemon({
    override: (_m, path) => {
      if (path === "/api/linear") return json(200, status);
      if (path.startsWith("/api/linear/issue-states")) return states();
      return undefined;
    },
  });
}

const stateCalls = () => daemon.calls.filter((c) => c.includes("/api/linear/issue-states"));

beforeEach(() => {
  resetGlobals();
  clock = 1_000_000;
  resetLinearIssueStore(() => clock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LinearIssueLink (DESIGN §24.3)", () => {
  it("shows the current title and state from Linear, asking once for every link on the page", async () => {
    install(CONNECTED);
    render(
      <>
        <LinearIssueLink issue={A} variant="canvas" />
        <LinearIssueLink issue={A} variant="badge" />
        <LinearIssueLink issue={B} variant="badge" />
      </>,
    );
    const links = await screen.findAllByRole("link", { name: "ENG-1 in Linear: In Progress" });
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute("href")).toBe(A.url);
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.textContent).toContain("New title");
    expect(links[1]!.textContent).toBe("ENG-1In Progress");
    // ENG-2 is unknown to Linear: identifier only.
    expect(screen.getByRole("link", { name: "ENG-2 in Linear" })).toBeTruthy();
    expect(stateCalls()).toEqual([`GET /api/linear/issue-states?ids=${encodeURIComponent("id-a,id-b")}`]);
  });

  it("asks again only after the cache expires", async () => {
    install(CONNECTED);
    const { unmount } = render(<LinearIssueLink issue={A} variant="badge" />);
    await screen.findByRole("link", { name: "ENG-1 in Linear: In Progress" });
    unmount();
    render(<LinearIssueLink issue={A} variant="badge" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(stateCalls()).toHaveLength(1);
    cleanup();
    clock += 61_000;
    render(<LinearIssueLink issue={A} variant="badge" />);
    await waitFor(() => expect(stateCalls()).toHaveLength(2));
  });

  it("falls back to the graph file's snapshot when Linear is not connected or fails", async () => {
    install({ connected: false, viewer: null, workspace: null, error: null });
    render(<LinearIssueLink issue={A} variant="canvas" />);
    const link = screen.getByRole("link", { name: "ENG-1 in Linear" });
    expect(link.textContent).toContain("Old title");
    await new Promise((r) => setTimeout(r, 10));
    expect(stateCalls()).toEqual([]);

    cleanup();
    resetGlobals();
    resetLinearIssueStore(() => clock);
    install(CONNECTED, () => json(502, { error: "down", code: "linear_unavailable" }));
    render(<LinearIssueLink issue={A} variant="canvas" />);
    await waitFor(() => expect(stateCalls()).toHaveLength(1));
    expect(screen.getByRole("link", { name: "ENG-1 in Linear" }).textContent).toContain("Old title");
  });
});
