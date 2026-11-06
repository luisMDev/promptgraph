import type { GraphListItem, RepoInfoResponse } from "@promptgraph/shared";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { repoApi, type RepoApi } from "../../api/rest";
import { MemoryLocationProvider, type NavigateOptions, type OpenInNewTabOptions } from "../../lib/router/location";
import { createRepoCache, setRepoCache, type RepoCache } from "../repo-cache";
import { ViewProvider, type ViewStores } from "./context";
import { createEditorStore, type EditorPersistence, type EditorStoreApi } from "./editor-store";
import { createRunStore, type RunStoreDeps } from "./run-store";
import { createViewUiStore } from "./ui-store";

export const TEST_REPO_ID = "repo-0123abcd";

export const TEST_REPO_INFO: RepoInfoResponse = { id: TEST_REPO_ID, path: "/repo", name: "repo", currentBranch: "main", branches: ["main"] };

export interface TestViewOptions {
  repoId?: string;
  /** Graph of the (unshared) editor store; null = a view without a graph. */
  graphId?: string | null;
  /** Initial location. */
  path?: string;
  active?: boolean;
  editor?: EditorStoreApi;
  persistence?: EditorPersistence;
  runDeps?: Partial<RunStoreDeps>;
  /** Overrides of the repository API (the rest goes to fetch). */
  api?: Partial<RepoApi>;
  repoInfo?: RepoInfoResponse | null;
  graphs?: GraphListItem[];
}

export interface TestView extends ViewStores {
  cache: RepoCache;
  /** Where the view navigated (latest last) and the new-tab requests. */
  location: { path: string; navigations: { path: string; replace: boolean }[]; newTabs: { path: string; activate: boolean }[] };
  Wrapper: (props: { children: ReactNode }) => ReactElement;
  render(ui: ReactElement): RenderResult;
}

const never = <T,>() => new Promise<T>(() => undefined);

/**
 * Test helper: the stores of one view (editor, run, UI, and the repository cache), provided with an
 * in-memory location. Every dependency defaults to an inert fake: nothing reaches the network unless a
 * test passes it in.
 */
export function createTestView(opts: TestViewOptions = {}): TestView {
  const repoId = opts.repoId ?? TEST_REPO_ID;
  const api = { ...repoApi(repoId), ...opts.api } as RepoApi;
  const editor =
    opts.editor ??
    createEditorStore(repoId, opts.graphId ?? null, {
      persistence: opts.persistence ?? { load: () => never(), save: async (graph) => ({ graph, hash: "saved" }) },
    });
  const run = createRunStore(repoId, { subscribe: () => () => undefined, fetchRun: () => never(), listRuns: async () => [], ...opts.runDeps });
  const ui = createViewUiStore();
  const cache = createRepoCache(repoId, api);
  cache.setState({ info: opts.repoInfo === undefined ? { ...TEST_REPO_INFO, id: repoId } : opts.repoInfo, graphs: opts.graphs ?? [] });
  setRepoCache(repoId, cache);
  const stores: ViewStores = { repoId, api, editor, run, ui, active: opts.active ?? true };
  const location: TestView["location"] = { path: opts.path ?? "/", navigations: [], newTabs: [] };
  const onNavigate = (path: string, o?: NavigateOptions) => {
    location.path = path;
    location.navigations.push({ path, replace: !!o?.replace });
  };
  const onOpenInNewTab = (path: string, o: OpenInNewTabOptions) => location.newTabs.push({ path, activate: o.activate });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryLocationProvider initialPath={opts.path ?? "/"} onNavigate={onNavigate} onOpenInNewTab={onOpenInNewTab}>
        <ViewProvider value={stores}>{children}</ViewProvider>
      </MemoryLocationProvider>
    );
  }
  return { ...stores, cache, location, Wrapper, render: (el) => render(el, { wrapper: Wrapper }) };
}
