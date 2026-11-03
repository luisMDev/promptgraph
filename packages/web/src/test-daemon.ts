import type { DaemonInfoResponse, GetGraphResponse, Graph, GraphListItem, RepoInfoResponse, RepoSummary, RunDetail, RunReportResponse } from "@promptgraph/shared";
import { vi } from "vitest";
import { setDesktopBridge } from "./lib/desktop";
import { useDaemonStore } from "./store/daemon-store";
import { resetReloginStore } from "./store/relogin-store";
import { clearRepoCaches } from "./store/repo-cache";
import { useToastStore } from "./store/toast-store";
import { discardEditorsOf, liveEditorStores } from "./store/view/editor-store";

/** A fake daemon behind `fetch` and `WebSocket` for the web's integration tests (no network, no server). */

export const REPO = "repo-0123abcd";

export const daemonInfo: DaemonInfoResponse = {
  version: "0.1.0",
  pid: 1,
  port: 4777,
  startedAt: 1,
  phase: 1,
  warnings: [],
  supportedNodeTypes: ["prompt", "command", "shell", "commit"],
  notificationsAvailable: true,
};

export function summaryOf(patch: Partial<RepoSummary> = {}): RepoSummary {
  return {
    id: REPO,
    path: "/work/repo",
    name: "repo",
    available: true,
    active: false,
    error: null,
    addedAt: 1,
    lastOpenedAt: 2,
    lastRunAt: null,
    runs: { running: 0, paused: 0 },
    waiting: { approval: 0, input: 0 },
    ...patch,
  };
}

export interface FakeRepo {
  info: RepoInfoResponse;
  graphs: Record<string, GetGraphResponse>;
  runs: Record<string, RunDetail>;
  reports?: Record<string, RunReportResponse>;
}

export interface FakeDaemon {
  repos: Record<string, FakeRepo>;
  summaries: RepoSummary[];
  /** `METHOD path` of every request, in order. */
  calls: string[];
  /** Bodies of PUT/POST requests, by `METHOD path`. */
  bodies: { call: string; body: unknown }[];
  /** Per-route overrides: return a Response to answer instead of the fake. */
  override?: (method: string, path: string, body: unknown) => Response | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function listItem(id: string, g: GetGraphResponse): GraphListItem {
  return { id, name: g.graph.name, loadError: null, updatedAt: 1, hash: g.hash };
}

/** Installs the fake as `fetch`; returns it for assertions. */
export function installFakeDaemon(init: Partial<Pick<FakeDaemon, "repos" | "summaries" | "override">> = {}): FakeDaemon {
  const d: FakeDaemon = { repos: init.repos ?? {}, summaries: init.summaries ?? [], calls: [], bodies: [], override: init.override };
  vi.stubGlobal("fetch", async (url: string, req: RequestInit = {}) => {
    const method = req.method ?? "GET";
    const u = new URL(url, "http://127.0.0.1:4777");
    const path = u.pathname + u.search;
    const call = `${method} ${path}`;
    d.calls.push(call);
    const body: unknown = typeof req.body === "string" ? JSON.parse(req.body) : undefined;
    if (body !== undefined) d.bodies.push({ call, body });
    const over = d.override?.(method, path, body);
    if (over) return over;
    const p = u.pathname;
    if (p === "/api/daemon") return json(200, daemonInfo);
    if (p === "/api/settings") return json(200, { notifications: true });
    if (p === "/api/repos" && method === "GET") return json(200, { repos: d.summaries });
    const m = /^\/api\/repos\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json(404, { error: "Not found", code: "not_found" });
    const repoId = decodeURIComponent(m[1]!);
    const rest = m[2] ?? "";
    const repo = d.repos[repoId];
    if (!repo) return json(404, { error: "Unknown repository", code: "unknown_repo" });
    if (rest === "") return json(200, repo.info);
    if (rest === "/graphs") return json(200, { graphs: Object.entries(repo.graphs).map(([id, g]) => listItem(id, g)) });
    const g = /^\/graphs\/([^/]+)$/.exec(rest);
    if (g) {
      const id = decodeURIComponent(g[1]!);
      if (method === "PUT") return json(200, { graph: body as Graph, hash: `h-${d.bodies.length}` });
      const graph = repo.graphs[id];
      return graph ? json(200, graph) : json(404, { error: "Graph not found", code: "not_found" });
    }
    if (rest === "/runs") return json(200, { runs: Object.values(repo.runs).map(({ run: { graphSnapshot: _s, ...summary } }) => summary) });
    const r = /^\/runs\/([^/]+)(\/report)?$/.exec(rest);
    if (r) {
      const id = decodeURIComponent(r[1]!);
      if (r[2]) {
        const report = repo.reports?.[id];
        return report ? json(200, report) : json(404, { error: "Run not found", code: "not_found" });
      }
      const run = repo.runs[id];
      return run ? json(200, run) : json(404, { error: "Run not found", code: "not_found" });
    }
    if (rest === "/pending") return json(200, { nodeRuns: [] });
    if (rest === "/commands") return json(200, { commands: [] });
    return json(404, { error: "Not found", code: "not_found" });
  });
  return d;
}

export class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  static last(): FakeSocket | undefined {
    return FakeSocket.instances.at(-1);
  }
  /** Every message sent on every socket of this test. */
  static allSent(): Record<string, unknown>[] {
    return FakeSocket.instances.flatMap((s) => s.sent);
  }
}

/** Resets the page-global state between tests (daemon store, repository caches, editor stores, toasts). */
export function resetGlobals(): void {
  useDaemonStore.setState({ info: null, infoError: null, repos: null, reposError: null, settings: null, connection: "connecting", signedOut: false, versionMismatch: false, removed: {} });
  for (const s of liveEditorStores()) discardEditorsOf(s.getState().repoId);
  clearRepoCaches();
  useToastStore.setState({ toasts: [] });
  FakeSocket.instances = [];
  localStorage.clear();
  setDesktopBridge(null);
  resetReloginStore();
}
