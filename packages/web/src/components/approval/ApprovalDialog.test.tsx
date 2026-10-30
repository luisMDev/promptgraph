// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApprovalInfoResponse, ApprovalRequest, DiffResponse } from "@promptgraph/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeRunOf } from "../../test-fixtures";

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

vi.mock("../../api/rest", async (orig) => {
  const actual = await orig<typeof import("../../api/rest")>();
  return {
    ...actual,
    api: {
      approvalInfo: () => approvalInfo(),
      diff: async () => diff,
      submitApproval: (id: string, req: ApprovalRequest) => submitApproval(id, req),
      pending: async () => ({ nodeRuns: [] }),
    },
  };
});

afterEach(() => {
  cleanup();
  submitApproval.mockClear();
  approvalInfo.mockClear();
});

/** Opens the dialog for the gate, listed as pending like the header's pending list does. */
async function openGate() {
  const { ApprovalDialog } = await import("./ApprovalDialog");
  const { useUiStore } = await import("../../store/ui-store");
  const { useAppStore } = await import("../../store/app-store");
  useAppStore.setState({ pending: [gate] });
  useUiStore.getState().openApproval("np");
  render(<ApprovalDialog nodeRunId="np" />);
  return { useUiStore, useAppStore };
}

describe("ApprovalDialog", () => {
  it("shows the gate, renders the diff in both layouts and approves with the edited PR title", async () => {
    const { useUiStore } = await openGate();

    expect(await screen.findByText("Check the API change")).toBeTruthy();
    expect(screen.getByText("Implement")).toBeTruthy();
    expect((await screen.findAllByText("src/api.ts")).length).toBeGreaterThan(0);
    expect(document.querySelector(".d2h-file-wrapper")).toBeTruthy();
    expect(document.querySelector(".d2h-file-side-diff")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
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
});
