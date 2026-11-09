// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import type { GraphListItem } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphOf } from "../../test-fixtures";
import { createGraph, deleteGraph } from "../../store/view/actions";
import { createTestView, type TestView } from "../../store/view/test-view";
import { GraphSelector } from "./GraphSelector";

vi.mock("../../store/view/actions", async (orig) => {
  const actual = await orig<typeof import("../../store/view/actions")>();
  return { ...actual, createGraph: vi.fn(async () => undefined), deleteGraph: vi.fn(async () => undefined) };
});

const graphs: GraphListItem[] = [
  { id: "g1", name: "Graph 1", loadError: null, updatedAt: 1, hash: "h1" },
  { id: "g2", name: "Graph 2", loadError: null, updatedAt: 2, hash: "h2" },
];

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: /Graph 1/ });
}

describe("GraphSelector", () => {
  let view: TestView;
  const render = (ui: ReactElement) => view.render(ui);

  beforeEach(() => {
    vi.mocked(createGraph).mockClear();
    vi.mocked(deleteGraph).mockClear();
    view = createTestView({ graphId: "g1", graphs, path: "/r/repo-0123abcd/graphs/g1" });
    view.editor.setState({ graph: graphOf({ id: "g1", name: "Graph 1" }), loading: false, loadError: null, activeRunId: null });
  });
  afterEach(cleanup);

  it("opens from the keyboard, moves focus between items and closes on Escape back to the trigger", async () => {
    const user = userEvent.setup();
    render(<GraphSelector />);
    trigger().focus();
    await user.keyboard("{Enter}");

    const menu = await screen.findByRole("menu");
    const current = screen.getByRole("menuitemradio", { name: /Graph 1/ });
    expect(current.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    // Enter focuses the first item.
    expect(document.activeElement).toBe(current);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: /Graph 2/ }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /New graph/ }));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  it("opens with ArrowDown too", async () => {
    const user = userEvent.setup();
    render(<GraphSelector />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  });

  it("graphs are links: selecting one navigates to it and closes the menu", async () => {
    const user = userEvent.setup();
    render(<GraphSelector />);
    await user.click(trigger());
    const item = await screen.findByRole("menuitemradio", { name: /Graph 2/ });
    expect(item.getAttribute("href")).toBe("/r/repo-0123abcd/graphs/g2");
    await user.click(item);
    expect(view.location.navigations).toEqual([{ path: "/r/repo-0123abcd/graphs/g2", replace: false }]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("links to the repository's graph list", async () => {
    const user = userEvent.setup();
    render(<GraphSelector />);
    await user.click(trigger());
    const item = await screen.findByRole("menuitem", { name: /All graphs/ });
    expect(item.getAttribute("href")).toBe("/r/repo-0123abcd");
  });

  it("selects a graph with the keyboard (Enter on a link item)", async () => {
    const user = userEvent.setup();
    render(<GraphSelector />);
    trigger().focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(view.location.navigations.at(-1)?.path).toBe("/r/repo-0123abcd/graphs/g2");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Ctrl-click on a graph opens it in a background tab", async () => {
    const user = userEvent.setup();
    render(<GraphSelector />);
    await user.click(trigger());
    await user.keyboard("{Control>}");
    await user.click(await screen.findByRole("menuitemradio", { name: /Graph 2/ }));
    await user.keyboard("{/Control}");
    expect(view.location.newTabs).toEqual([{ path: "/r/repo-0123abcd/graphs/g2", activate: false }]);
    expect(view.location.navigations).toEqual([]);
  });

  it("closes on a click outside", async () => {
    // The open menu is modal (the page behind has pointer-events: none); Radix dismisses on the outside pointerdown.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <>
        <GraphSelector />
        <p>outside</p>
      </>,
    );
    await user.click(trigger());
    expect(await screen.findByRole("menu")).toBeTruthy();
    await user.click(screen.getByText("outside"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("New graph opens the prompt dialog with focus inside, and creates the graph", async () => {
    const user = userEvent.setup();
    render(<GraphSelector />);
    await user.click(trigger());
    await user.click(await screen.findByRole("menuitem", { name: /New graph/ }));

    const dialog = await screen.findByRole("dialog", { name: "New graph" });
    expect(screen.queryByRole("menu")).toBeNull();
    const input = screen.getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.type(input, "My flow");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(createGraph).toHaveBeenCalledWith(expect.objectContaining({ repoId: "repo-0123abcd" }), { name: "My flow", issues: [] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("Delete asks for confirmation and deletes the current graph", async () => {
    const user = userEvent.setup();
    render(<GraphSelector />);
    await user.click(trigger());
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }));

    const dialog = await screen.findByRole("dialog", { name: "Delete graph" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteGraph).toHaveBeenCalledWith(expect.objectContaining({ repoId: "repo-0123abcd" }), "g1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Rename and Delete are disabled while the graph is read-only", async () => {
    view.editor.setState({ activeRunId: "r1" });
    const user = userEvent.setup();
    render(<GraphSelector />);
    await user.click(trigger());
    expect((await screen.findByRole("menuitem", { name: /Rename/ })).getAttribute("aria-disabled")).toBe("true");
    const del = await screen.findByRole("menuitem", { name: /Delete/ });
    expect(del.getAttribute("aria-disabled")).toBe("true");
  });

  it("the Rename menu item opens the rename dialog prefilled with the graph name", async () => {
    const rename = vi.spyOn(view.editor.getState(), "rename").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<GraphSelector />);
    await user.click(trigger());
    await user.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    // The field's hint is part of the label, hence the prefix match.
    const input = await screen.findByRole("textbox", { name: /^Name/ });
    expect((input as HTMLInputElement).value).toBe("Graph 1");
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");
    expect(rename).toHaveBeenCalledWith("Renamed");
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    rename.mockRestore();
  });
});
