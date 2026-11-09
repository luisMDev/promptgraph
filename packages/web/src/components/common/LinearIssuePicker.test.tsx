// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GraphIssue, LinearStatusResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDaemon, resetGlobals } from "../../test-daemon";
import { LinearIssuePicker } from "./LinearIssuePicker";

const issue = (n: number): GraphIssue => ({ provider: "linear", id: `i${n}`, identifier: `ENG-${n}`, title: `Issue ${n}`, url: `https://linear.app/acme/issue/ENG-${n}` });
const CONNECTED: LinearStatusResponse = { connected: true, viewer: null, workspace: null, error: null };
const DISCONNECTED: LinearStatusResponse = { connected: false, viewer: null, workspace: null, error: null };

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function install(status: LinearStatusResponse) {
  installFakeDaemon({
    override: (_m, path) => {
      if (path === "/api/linear") return json(status);
      if (path.startsWith("/api/linear/issues")) return json({ issues: [1, 2, 3].map((n) => ({ ...issue(n), state: null, teamKey: "ENG", assignee: null })) });
      return undefined;
    },
  });
}

beforeEach(() => resetGlobals());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LinearIssuePicker (DESIGN §24.2)", () => {
  it("keeps showing linked issues without a connection, but offers no search", async () => {
    install(DISCONNECTED);
    render(<LinearIssuePicker selected={[issue(1)]} onChange={() => undefined} hideWhenDisconnected />);
    expect(within(screen.getByRole("list", { name: "Linked Linear issues" })).getByText("Issue 1")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole("button", { name: /Link/ })).toBeNull();
  });

  it("appends what the search dialog adds and is read-only when disabled", async () => {
    install(CONNECTED);
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<LinearIssuePicker selected={[issue(1)]} onChange={onChange} />);
    await user.click(await screen.findByRole("button", { name: "Link more issues…" }));
    const search = await screen.findByRole("dialog", { name: "Link Linear issues" });
    const list = within(search).getByRole("listbox");
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(3));
    await user.click(within(list).getByRole("option", { name: /ENG-3/ }));
    await user.click(within(list).getByRole("option", { name: /ENG-2/ }));
    await user.click(within(search).getByRole("button", { name: "Add 2 issues" }));
    expect(onChange).toHaveBeenCalledWith([issue(1), issue(3), issue(2)]);

    rerender(<LinearIssuePicker selected={[issue(1)]} onChange={onChange} disabled />);
    expect(screen.queryByRole("button", { name: /Unlink/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Link more/ })).toBeNull();
  });
});
