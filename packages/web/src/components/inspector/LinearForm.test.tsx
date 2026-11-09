// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { DEFAULT_LINEAR_UPDATE_PROMPT, type GraphNodeOf } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { configPreview } from "../../lib/node-meta";
import { graphOf } from "../../test-fixtures";
import { createTestView } from "../../store/view/test-view";
import { Inspector } from "./Inspector";

afterEach(cleanup);

const node = () => {
  const n = editorGraph().nodes[0]!;
  return n as GraphNodeOf<"linear">;
};
let editorGraph: () => ReturnType<typeof graphOf>;

describe("linear node form (§24.5)", () => {
  it("prefills the default instructions, saves an override and resets it", () => {
    const view = createTestView({});
    view.editor.setState({
      graph: graphOf({
        issues: [{ provider: "linear", id: "i1", identifier: "ENG-1", title: "T", url: "https://linear.app/acme/issue/ENG-1" }],
        nodes: [{ id: "lin", type: "linear", label: "Update Linear", position: { x: 0, y: 0 }, config: {} }],
      }),
      loading: false,
      loadError: null,
      activeRunId: null,
    });
    editorGraph = () => view.editor.getState().graph!;
    view.editor.getState().setSelection(["lin"], []);
    view.render(<Inspector />);

    const instructions = screen.getByDisplayValue(DEFAULT_LINEAR_UPDATE_PROMPT);
    expect(screen.getByText(/Updates the 1 Linear issue linked to this graph/)).toBeTruthy();
    expect(configPreview(node())).toBe("Default instructions · comments + states · approval");

    fireEvent.change(instructions, { target: { value: "Only comment on what was tested." } });
    expect(node().config.prompt).toBe("Only comment on what was tested.");
    expect(configPreview(node())).toMatch(/^Custom instructions/);

    fireEvent.click(screen.getByRole("button", { name: "Use default instructions" }));
    expect(node().config.prompt).toBeUndefined();
    // Typing the default text back counts as the default too.
    fireEvent.change(screen.getByDisplayValue(DEFAULT_LINEAR_UPDATE_PROMPT), { target: { value: DEFAULT_LINEAR_UPDATE_PROMPT } });
    expect(node().config.prompt).toBeUndefined();

    fireEvent.click(screen.getByRole("checkbox", { name: "Propose state changes" }));
    expect(node().config.allowStateChanges).toBe(false);
    expect(configPreview(node())).toBe("Default instructions · comments · approval");
  });
});
