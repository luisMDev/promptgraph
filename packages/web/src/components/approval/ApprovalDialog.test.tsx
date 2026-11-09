// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ApprovalInfoResponse, ApprovalRequest, DiffResponse } from "@promptgraph/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoApi } from "../../api/rest";
import { nodeRunOf } from "../../test-fixtures";
import { createTestView } from "../../store/view/test-view";

const gate = nodeRunOf({ id: "np", nodeId: "p", status: "waiting_approval" });
const info: ApprovalInfoResponse = {
  nodeRun: gate,
  message: "Check the API change",
  showDiff: true,
  pr: { title: "Add API", body: "Generated body", base: "main", draft: true },
  predecessorOutputs: [{ nodeId: "a", label: "Implement", text: "Added /users" }],
};
const diff: DiffResponse = {
  base: "main",
  head: "abc",
  files: [{ path: "src/api.ts", status: "modified", additions: 1, deletions: 1, binary: false }],
  patch: "diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1 +1 @@\n-old line\n+new line\n",
  truncated: false,
};
const submitApproval = vi.fn(async (_id: string, _req: ApprovalRequest) => ({ nodeRun: { ...gate, status: "running" as const } }));
const approvalInfo = vi.fn(async () => info);

const api: Partial<RepoApi> = {
  approvalInfo: () => approvalInfo(),
  diff: async () => diff,
  submitApproval: (id: string, req: ApprovalRequest) => submitApproval(id, req),
  pending: async () => ({ nodeRuns: [] }),
};

afterEach(() => {
  cleanup();
  submitApproval.mockClear();
  approvalInfo.mockClear();
});

/** Opens the dialog for the gate, listed as pending like the header's pending list does. */
async function openGate() {
  const { ApprovalDialog } = await import("./ApprovalDialog");
  const view = createTestView({ api });
  view.cache.setState({ pending: [gate] });
  view.ui.getState().openApproval("np");
  view.render(<ApprovalDialog nodeRunId="np" />);
  return { useUiStore: view.ui, useAppStore: view.cache };
}

describe("ApprovalDialog", () => {
  it("shows the gate, renders the diff in both layouts and approves with the edited PR title", async () => {
    const { useUiStore } = await openGate();

    expect(await screen.findByText("Check the API change")).toBeTruthy();
    expect(screen.getByText("Implement")).toBeTruthy();
    expect((await screen.findAllByText("src/api.ts")).length).toBeGreaterThan(0);
    expect(document.querySelector(".d2h-file-wrapper")).toBeTruthy();
    expect(document.querySelector(".d2h-file-side-diff")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Side by side" }));
    expect(document.querySelector(".d2h-file-side-diff")).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("Add API"), { target: { value: "Add users API" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve & push" }));
    await waitFor(() => expect(submitApproval).toHaveBeenCalledWith("np", { approved: true, title: "Add users API", body: "Generated body", headSha: "abc" }));
    await waitFor(() => expect(useUiStore.getState().approvalNodeRunId).toBeNull());
  });

  it("disables the decision once the gate is decided elsewhere", async () => {
    const { useAppStore } = await openGate();
    const approve = await screen.findByRole("button", { name: "Approve & push" });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    useAppStore.setState({ pending: [] });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("This gate is no longer waiting for approval.")).toBeTruthy();
  });

  it("reloads the gate when the decision is refused (409)", async () => {
    const { ApiRequestError } = await import("../../api/rest");
    submitApproval.mockRejectedValueOnce(new ApiRequestError(409, { error: "The branch changed since you loaded the diff", code: "invalid_state" }));
    await openGate();
    const approve = await screen.findByRole("button", { name: "Approve & push" });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    expect(await screen.findByText("The branch changed since you loaded the diff")).toBeTruthy();
    await waitFor(() => expect(approvalInfo).toHaveBeenCalledTimes(2));
  });

  it("edits the proposed Linear updates and approves only the ones to apply (§24.5)", async () => {
    const states = [
      { id: "s-todo", name: "Todo", type: "unstarted", color: "#ccc" },
      { id: "s-review", name: "In Review", type: "started", color: "#0cf" },
    ];
    const proposal = (n: number, comment: string, stateId: string | null) => ({
      issueId: `i${n}`,
      identifier: `ENG-${n}`,
      title: `Issue ${n}`,
      url: `https://linear.app/acme/issue/ENG-${n}`,
      currentState: states[0]!,
      states,
      comment,
      stateId,
    });
    approvalInfo.mockResolvedValueOnce({
      ...info,
      message: null,
      showDiff: false,
      pr: null,
      linear: { proposals: [proposal(1, "Implemented the API.", "s-review"), proposal(2, "", null)], allowComments: true, allowStateChanges: true },
    });
    await openGate();
    const list = await screen.findByRole("list", { name: "Proposed Linear updates" });
    expect(screen.getByRole("heading", { name: /Approve Linear updates/ })).toBeTruthy();
    expect(list.querySelectorAll("li")).toHaveLength(2);
    // ENG-2 has no proposal: not applied, no editor.
    const update2 = screen.getByRole("checkbox", { name: "Update ENG-2" });
    expect(update2.getAttribute("aria-checked")).toBe("false");
    expect(screen.getAllByLabelText("Comment", { exact: false }).filter((el) => el.tagName === "TEXTAREA")).toHaveLength(2);

    fireEvent.change(screen.getByDisplayValue("Implemented the API."), { target: { value: "Implemented the API, tests pending." } });
    fireEvent.click(update2);
    const item2 = within(list).getByRole("listitem", { name: "ENG-2" });
    fireEvent.change(within(item2).getByRole("textbox"), { target: { value: "Started" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve & update Linear" }));
    await waitFor(() =>
      expect(submitApproval).toHaveBeenCalledWith("np", {
        approved: true,
        linearUpdates: [
          { issueId: "i1", comment: "Implemented the API, tests pending.", stateId: "s-review" },
          { issueId: "i2", comment: "Started", stateId: null },
        ],
      }),
    );
  });

  it("cannot approve Linear updates when none is selected", async () => {
    approvalInfo.mockResolvedValueOnce({
      ...info,
      pr: null,
      showDiff: false,
      linear: {
        proposals: [{ issueId: "i1", identifier: "ENG-1", title: "T", url: "https://linear.app/acme/issue/ENG-1", currentState: null, states: [], comment: "c", stateId: null }],
        allowComments: true,
        allowStateChanges: false,
      },
    });
    await openGate();
    const approve = (await screen.findByRole("button", { name: "Approve & update Linear" })) as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(screen.queryByText("State")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Update ENG-1" }));
    expect(approve.disabled).toBe(true);
  });
});
