// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLocationProvider } from "../../lib/router/location";
import { REPO, installFakeDaemon, resetGlobals, type FakeDaemon } from "../../test-daemon";
import { linearGraph } from "../../test-fixtures";
import { RepoView } from "../../views/RepoView";
import { dispatcher } from "../live";
import { useToastStore } from "../toast-store";
import { AUTOSAVE_DELAY_MS, acquireEditorStore, findEditorStore, flushAllEditors } from "./editor-store";

vi.mock("../../components/terminal/TerminalView", () => ({ TerminalView: () => null }));

const graph = linearGraph();
const route = { kind: "graph" as const, repoId: REPO, graphId: "g1" };
let daemon: FakeDaemon;

const puts = () => daemon.calls.filter((c) => c.startsWith("PUT "));

function View({ id }: { id: string }) {
  return (
    <div data-testid={id}>
      <MemoryLocationProvider initialPath={`/r/${REPO}/graphs/g1`}>
        <RepoView route={route} />
      </MemoryLocationProvider>
    </div>
  );
}

beforeEach(() => {
  resetGlobals();
  daemon = installFakeDaemon({
    repos: {
      [REPO]: {
        info: { id: REPO, path: "/work/repo", name: "repo", currentBranch: "main", branches: ["main"] },
        graphs: { g1: { graph, hash: "h0", modifiedOutside: false, activeRunId: null }, g2: { graph: { ...graph, id: "g2", name: "Other" }, hash: "h2", modifiedOutside: false, activeRunId: null } },
        runs: {},
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("per-view stores (DESIGN §13.4)", () => {
  it("two views of the same graph share one editor store and autosave once", async () => {
    render(
      <>
        <View id="a" />
        <View id="b" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText("Implement")).toHaveLength(2));
    expect(daemon.calls.filter((c) => c === `GET /api/repos/${REPO}/graphs/g1`)).toHaveLength(1);
    const editor = findEditorStore(REPO, "g1")!;
    act(() => editor.getState().rename("Renamed"));
    // Both views show the edit: they render the same store.
    expect(screen.getAllByDisplayValue("Renamed")).toHaveLength(2);
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: AUTOSAVE_DELAY_MS * 4 });
    await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 100));
    expect(puts()).toEqual([`PUT /api/repos/${REPO}/graphs/g1?baseHash=h0`]);
  });

  it("releasing the last reference during the debounce flushes the pending save, then disposes the store", async () => {
    const { unmount } = render(<View id="a" />);
    await screen.findByText("Implement");
    const editor = findEditorStore(REPO, "g1")!;
    act(() => editor.getState().rename("Before close"));
    expect(puts()).toEqual([]);
    unmount();
    // Well before the 500 ms debounce.
    await waitFor(() => expect(puts()).toEqual([`PUT /api/repos/${REPO}/graphs/g1?baseHash=h0`]), { timeout: 200 });
    expect(daemon.bodies.find((b) => b.call.startsWith("PUT"))?.body).toMatchObject({ name: "Before close" });
    await waitFor(() => expect(findEditorStore(REPO, "g1")).toBeUndefined());
  });

  it("keeps the store while another view still holds it", async () => {
    const persistence = { load: vi.fn(async () => ({ graph, hash: "h0", modifiedOutside: false, activeRunId: null })), save: vi.fn(async (g: typeof graph) => ({ graph: g, hash: "h1" })) };
    const a = acquireEditorStore(REPO, "g9", { persistence });
    const b = acquireEditorStore(REPO, "g9", { persistence });
    expect(b.store).toBe(a.store);
    await waitFor(() => expect(a.store.getState().graph).not.toBeNull());
    a.store.getState().rename("Still open");
    await a.release();
    expect(persistence.save).not.toHaveBeenCalled();
    expect(findEditorStore(REPO, "g9")).toBe(b.store);
    await b.release();
    expect(persistence.save).toHaveBeenCalledTimes(1);
    expect(findEditorStore(REPO, "g9")).toBeUndefined();
    expect(persistence.load).toHaveBeenCalledTimes(1);
  });

  it("pagehide flushes every dirty editor store", async () => {
    const save = vi.fn(async (g: typeof graph) => ({ graph: g, hash: "h1" }));
    const load = async (id: string) => ({ graph: { ...graph, id }, hash: "h0", modifiedOutside: false, activeRunId: null });
    const a = acquireEditorStore(REPO, "p1", { persistence: { load, save } });
    const b = acquireEditorStore(REPO, "p2", { persistence: { load, save } });
    await waitFor(() => expect(b.store.getState().graph).not.toBeNull());
    await waitFor(() => expect(a.store.getState().graph).not.toBeNull());
    a.store.getState().rename("A");
    b.store.getState().rename("B");
    await flushAllEditors();
    expect(save.mock.calls.map((c) => c[0].name).sort()).toEqual(["A", "B"]);
  });

  it("repo:removed discards the repository's editor stores with a toast, and never saves them", async () => {
    render(<View id="a" />);
    await screen.findByText("Implement");
    const editor = findEditorStore(REPO, "g1")!;
    act(() => editor.getState().rename("Unsaved"));
    act(() => dispatcher.handle({ type: "repo:removed", repoId: REPO }));
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["repo was removed; unsaved changes to Unsaved were not saved."]);
    expect(findEditorStore(REPO, "g1")).toBeUndefined();
    expect(editor.getState().discarded).toBe(true);
    await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 100));
    expect(puts()).toEqual([]);
  });
});
