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

vi.mock("../../api/rest", async (orig) => {
  const actual = await orig<typeof import("../../api/rest")>();
  return {
    ...actual,
    api: {
      approvalInfo: async () => info,
      diff: async () => diff,
      submitApproval: (id: string, req: ApprovalRequest) => submitApproval(id, req),
      pending: async () => ({ nodeRuns: [] }),
    },
  };
});

afterEach(cleanup);

describe("ApprovalDialog", () => {
  it("shows the gate, renders the diff in both layouts and approves with the edited PR title", async () => {
    const { ApprovalDialog } = await import("./ApprovalDialog");
    const { useUiStore } = await import("../../store/ui-store");
    useUiStore.getState().openApproval("np");
    render(<ApprovalDialog nodeRunId="np" />);

    expect(await screen.findByText("Check the API change")).toBeTruthy();
    expect(screen.getByText("Implement")).toBeTruthy();
    expect((await screen.findAllByText("src/api.ts")).length).toBeGreaterThan(0);
    expect(document.querySelector(".d2h-file-wrapper")).toBeTruthy();
    expect(document.querySelector(".d2h-file-side-diff")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(document.querySelector(".d2h-file-side-diff")).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("Add API"), { target: { value: "Add users API" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve & push" }));
    await waitFor(() => expect(submitApproval).toHaveBeenCalledWith("np", { approved: true, title: "Add users API", body: "Generated body" }));
    await waitFor(() => expect(useUiStore.getState().approvalNodeRunId).toBeNull());
  });
});
