// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiffResponse, DiffScope } from "@promptgraph/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoApi } from "../../api/rest";
import { useViewUi } from "../../store/view/context";
import { createTestView, type TestView } from "../../store/view/test-view";
import type { DiffTarget } from "../../store/view/ui-store";
import { DiffDialog } from "./DiffDialog";

const diff: DiffResponse = {
  base: "main",
  head: "abc",
  files: [{ path: "src/api.ts", status: "modified", additions: 1, deletions: 1, binary: false }],
  patch: "diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1 +1 @@\n-old line\n+new line\n",
  truncated: false,
};
const nodeDiff = vi.fn(async (_id: string, _scope?: DiffScope) => diff);
const laneDiff = vi.fn(async (_runId: string, _laneId: string) => diff);

const api: Partial<RepoApi> = {
  diff: (id: string, scope?: DiffScope) => nodeDiff(id, scope),
  laneDiff: (runId: string, laneId: string) => laneDiff(runId, laneId),
};
let view: TestView;
const useUiStore = { getState: () => view.ui.getState() };

afterEach(() => {
  cleanup();
  nodeDiff.mockClear();
  laneDiff.mockClear();
});

const target: DiffTarget = { kind: "node", nodeRunId: "nr1", title: "Implement · changes" };

/** Renders the dialog the way App does: mounted while the ui-store holds a diff target. */
function Host() {
  const t = useViewUi((s) => s.diffTarget);
  return t ? <DiffDialog target={t} /> : null;
}

function open(t: DiffTarget = target) {
  view = createTestView({ api });
  view.ui.getState().openDiff(t);
  view.render(<Host />);
}

describe("DiffDialog", () => {
  it("is a dialog named by its title with focus inside it", async () => {
    open();
    const dialog = await screen.findByRole("dialog", { name: "Implement · changes" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(await screen.findByText("Changes made by this step")).toBeTruthy();
    expect(nodeDiff).toHaveBeenCalledWith("nr1", "node");
  });

  it("switches to the whole lane and keeps one scope selected", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Changes made by this step");
    const step = screen.getByRole("radio", { name: "This step" });
    const lane = screen.getByRole("radio", { name: "Whole lane" });
    expect(step.getAttribute("aria-checked")).toBe("true");

    await user.click(lane);
    await waitFor(() => expect(nodeDiff).toHaveBeenLastCalledWith("nr1", "lane"));
    expect(lane.getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByText("Changes since base")).toBeTruthy();

    // Clicking the selected item does not deselect it.
    await user.click(lane);
    expect(lane.getAttribute("aria-checked")).toBe("true");
  });

  it("loads a lane of a run without the scope switch", async () => {
    open({ kind: "lane", runId: "r1", laneId: "L1", title: "Lane L1" });
    await screen.findByRole("dialog", { name: "Lane L1" });
    await waitFor(() => expect(laneDiff).toHaveBeenCalledWith("r1", "L1"));
    expect(screen.queryByRole("radio", { name: "Whole lane" })).toBeNull();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole("dialog", { name: "Implement · changes" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(useUiStore.getState().diffTarget).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a load error as an alert", async () => {
    nodeDiff.mockRejectedValueOnce(new Error("boom"));
    open();
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load the diff: boom");
  });
});
