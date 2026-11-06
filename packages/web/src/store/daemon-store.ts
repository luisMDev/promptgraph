import type { AppSettings, DaemonInfoResponse, RepoSummary, UsageLimits } from "@promptgraph/shared";
import { create } from "zustand";
import { daemonApi, errorMessage } from "../api/rest";
import type { ConnectionState, WsStatus } from "../api/ws";

/** A repository removed while this page was open: what "Add again" needs. */
export interface RemovedRepo {
  id: string;
  path: string;
  name: string;
}

/**
 * Daemon-wide state, global to the page (DESIGN §13.4): daemon info, the registered repositories (live from
 * `repo:status` / `repo:removed`), app settings, and the session/connection/version state (§13.5).
 */
export interface DaemonState {
  info: DaemonInfoResponse | null;
  infoError: string | null;
  /** null until first loaded. */
  repos: RepoSummary[] | null;
  reposError: string | null;
  settings: AppSettings | null;
  connection: ConnectionState;
  /** A 401 or a socket closed with 4401: the page stops retrying and shows "Signed out". */
  signedOut: boolean;
  /** `hello.version` differs from this web build. */
  versionMismatch: boolean;
  /** Repositories removed while this page was open ("Add again" posts the remembered path). */
  removed: Record<string, RemovedRepo>;
  /** Last observed subscription usage limits (§23.3), live from `usage:limits`; null when none was seen. */
  usageLimits: UsageLimits | null;

  loadInfo(): Promise<void>;
  loadRepos(): Promise<void>;
  loadSettings(): Promise<void>;
  /** GET /api/daemon/usage-limits (best effort). */
  loadUsageLimits(): Promise<void>;
  /** `usage:limits`. */
  applyUsageLimits(limits: UsageLimits): void;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  /** `repo:status`, or the result of POST /api/repos. */
  applyRepoStatus(repo: RepoSummary): void;
  /** `repo:removed`: forgets the repository and remembers its path (from its last summary, or `fallback`). */
  markRemoved(repoId: string, fallback?: RemovedRepo | null): void;
  /** POST /api/repos; 422 path_not_absolute / not_a_git_repo are thrown as ApiRequestError. */
  addRepo(path: string): Promise<RepoSummary>;
  applyWsStatus(status: WsStatus): void;
  setSignedOut(): void;
}

function sortRepos(repos: RepoSummary[]): RepoSummary[] {
  return [...repos].sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt) || a.name.localeCompare(b.name));
}

export const useDaemonStore = create<DaemonState>()((set, get) => ({
  info: null,
  infoError: null,
  repos: null,
  reposError: null,
  settings: null,
  connection: "connecting",
  signedOut: false,
  versionMismatch: false,
  removed: {},
  usageLimits: null,

  async loadInfo() {
    try {
      set({ info: await daemonApi.daemon(), infoError: null });
    } catch (err) {
      set({ infoError: errorMessage(err) });
    }
  },

  async loadUsageLimits() {
    try {
      const { limits } = await daemonApi.usageLimits();
      // A `usage:limits` that arrived meanwhile is newer.
      if (limits && (get().usageLimits?.observedAt ?? 0) <= limits.observedAt) set({ usageLimits: limits });
    } catch {
      // Best effort: shown when the next observation arrives.
    }
  },

  applyUsageLimits(limits) {
    set({ usageLimits: limits });
  },

  async loadRepos() {
    try {
      const { repos } = await daemonApi.repos();
      set({ repos: sortRepos(repos), reposError: null });
    } catch (err) {
      set({ reposError: errorMessage(err) });
    }
  },

  async loadSettings() {
    try {
      set({ settings: await daemonApi.getSettings() });
    } catch {
      // Shown as unavailable in the settings menu; retried when it opens.
    }
  },

  async updateSettings(patch) {
    const prev = get().settings;
    if (prev) set({ settings: { ...prev, ...patch } });
    try {
      set({ settings: await daemonApi.updateSettings(patch) });
    } catch (err) {
      set({ settings: prev });
      throw err;
    }
  },

  applyRepoStatus(repo) {
    const repos = get().repos;
    const { [repo.id]: _gone, ...removed } = get().removed;
    set({ removed, ...(repos ? { repos: sortRepos([...repos.filter((r) => r.id !== repo.id), repo]) } : {}) });
  },

  markRemoved(repoId, fallback) {
    const s = get();
    const summary = s.repos?.find((r) => r.id === repoId);
    const last: RemovedRepo | null = summary ? { id: repoId, path: summary.path, name: summary.name } : (fallback ?? s.removed[repoId] ?? null);
    set({
      repos: s.repos ? s.repos.filter((r) => r.id !== repoId) : s.repos,
      removed: last ? { ...s.removed, [repoId]: last } : s.removed,
    });
  },

  async addRepo(path) {
    const repo = await daemonApi.addRepo(path);
    get().applyRepoStatus(repo);
    return repo;
  },

  applyWsStatus(status) {
    set({
      connection: status.connection,
      versionMismatch: status.versionMismatch,
      ...(status.signedOut ? { signedOut: true } : {}),
    });
  },

  setSignedOut() {
    set({ signedOut: true });
  },
}));
