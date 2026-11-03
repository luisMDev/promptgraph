import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoSummary } from "@promptgraph/shared";
import type { LegacyRepoLocks } from "../config/instance-lock.js";
import { isInWorktreesDir, type PgPaths } from "../config/paths.js";
import { repoIdFor } from "../config/repo-id.js";
import type { EventBus } from "../events/bus.js";
import { resolveRepoRoot } from "../git/repo.js";
import { HttpError } from "../http/errors.js";
import type { RepoRow, RepoStatusCounts, Store } from "../store/store.js";
import { errorMessage } from "../util/text.js";
import type { RepoContext } from "./repo-context.js";

/** `meta` key set once the backfill committed (DESIGN §4.4). */
export const REPOS_BACKFILLED_KEY = "repos_backfilled";

export interface RepoRegistryDeps {
  store: Store;
  bus: EventBus;
  /** Lane worktrees under `worktreesDir` are refused as repositories (DESIGN §4.2). */
  paths: PgPaths;
  /** HOME expands a leading `~` (the daemon user's home). */
  env: NodeJS.ProcessEnv;
  legacyLocks: LegacyRepoLocks;
  /** Builds a context without side effects (createRepoContext). */
  createContext: (row: RepoRow) => RepoContext;
  now?: () => number;
}

interface Entry {
  /** Memoised load (cleared on failure). */
  load?: Promise<RepoContext>;
  ctx?: RepoContext;
  /** Memoised activation of `ctx` (cleared on failure). */
  activation?: Promise<void>;
  active: boolean;
  /** Last load/activation failure. */
  error: string | null;
  /** Set while the repository is being removed: requests and re-registration wait for it. */
  disposing?: Promise<void>;
}

const EMPTY_COUNTS: RepoStatusCounts = { running: 0, paused: 0, approval: 0, input: 0, lastRunAt: null };

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The registered repositories (DESIGN §4.2). Loading a repository builds its RepoContext without side
 * effects; activating it (POST /api/repos, repo:subscribe, any non-GET request) creates its graphs dir,
 * starts its watcher and prunes. Both are memoised per id; a failure clears the memo and is reported in
 * RepoSummary.error. Removing disposes the context first, and every request for that id waits for it.
 */
export class RepoRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  /** Set by shutdownAll: nothing is loaded, activated or added any more (a late context would never be disposed). */
  private closing = false;

  constructor(private readonly deps: RepoRegistryDeps) {
    this.now = deps.now ?? Date.now;
  }

  private entry(repoId: string): Entry {
    let e = this.entries.get(repoId);
    if (!e) {
      e = { active: false, error: null };
      this.entries.set(repoId, e);
    }
    return e;
  }

  /** 503 daemon_stopping once shutdownAll has started. */
  private assertOpen(): void {
    if (this.closing) throw new HttpError(503, "daemon_stopping", "The promptgraph daemon is stopping");
  }

  private changed(repoId: string): void {
    this.deps.bus.emit("repo:changed", { repoId });
  }

  row(repoId: string): RepoRow | undefined {
    return this.deps.store.getRepo(repoId);
  }

  /** Every registered repository with its status, in registration order (one counters query). */
  list(): RepoSummary[] {
    const counts = this.deps.store.repoStatusCounts();
    return this.deps.store.listRepos().map((row) => this.toSummary(row, counts.get(row.path) ?? EMPTY_COUNTS));
  }

  summary(repoId: string): RepoSummary | null {
    const row = this.row(repoId);
    if (!row) return null;
    return this.toSummary(row, this.deps.store.repoStatusCounts().get(row.path) ?? EMPTY_COUNTS);
  }

  private toSummary(row: RepoRow, counts: RepoStatusCounts): RepoSummary {
    const e = this.entries.get(row.id);
    return {
      id: row.id,
      path: row.path,
      name: row.name,
      available: isDirectory(row.path),
      active: e?.active ?? false,
      error: e?.error ?? e?.ctx?.watchError ?? null,
      addedAt: row.addedAt,
      lastOpenedAt: row.lastOpenedAt,
      lastRunAt: counts.lastRunAt,
      runs: { running: counts.running, paused: counts.paused },
      waiting: { approval: counts.approval, input: counts.input },
    };
  }

  /**
   * Registers a repository (idempotent): `~` expanded, absolute paths only (422 path_not_absolute),
   * resolved to the git top level and its realpath (422 not_a_git_repo); a lane worktree (at or under
   * `worktreesDir`) is refused with 422 lane_worktree. A known realpath only updates
   * lastOpenedAt. Takes its legacy lock (§4.4) and activates it; an activation failure is reported in
   * the returned summary, not thrown.
   */
  async add(inputPath: string): Promise<RepoSummary> {
    this.assertOpen();
    const home = this.deps.env.HOME || os.homedir();
    const expanded = inputPath === "~" ? home : inputPath.startsWith("~/") ? path.join(home, inputPath.slice(2)) : inputPath;
    if (!path.isAbsolute(expanded)) {
      throw new HttpError(422, "path_not_absolute", `Repository path must be absolute (or start with ~/): ${inputPath}`);
    }
    let real: string;
    try {
      real = fs.realpathSync(await resolveRepoRoot(expanded));
    } catch {
      throw new HttpError(422, "not_a_git_repo", `${expanded} is not inside a git repository`);
    }
    if (isInWorktreesDir(this.deps.paths, real)) {
      throw new HttpError(422, "lane_worktree", `${real} is a promptgraph lane worktree; register the repository it belongs to instead`);
    }
    const id = this.deps.store.getRepoByPath(real)?.id ?? repoIdFor(real);
    await this.entries.get(id)?.disposing?.catch(() => undefined);
    this.assertOpen();

    const { store } = this.deps;
    const existing = store.getRepoByPath(real);
    if (existing) {
      store.touchRepo(existing.id, this.now());
    } else {
      const now = this.now();
      store.insertRepo({ id, path: real, name: path.basename(real), addedAt: now, lastOpenedAt: now });
    }
    try {
      this.deps.legacyLocks.hold(real);
    } catch (err) {
      if (!existing) store.deleteRepo(id);
      throw new HttpError(409, "legacy_server_running", errorMessage(err));
    }
    this.changed(id);
    try {
      await this.activate(id);
    } catch {
      // Reported in the summary (error) and retried on the next trigger.
    }
    // A removal that ran while the activation waited leaves no row behind.
    const summary = this.summary(id);
    if (!summary) throw new HttpError(404, "unknown_repo", `Repository ${real} was removed while it was being added`);
    return summary;
  }

  /**
   * The repository's context, built on first use (no side effects). 404 unknown_repo for an unregistered
   * id, 409 repo_unavailable when its directory is gone; waits while the repository is being removed.
   */
  async load(repoId: string): Promise<RepoContext> {
    // Re-checked after each wait: a removal that starts meanwhile must not see a load it did not snapshot.
    for (let d = this.entries.get(repoId)?.disposing; d; d = this.entries.get(repoId)?.disposing) await d.catch(() => undefined);
    this.assertOpen();
    const row = this.row(repoId);
    if (!row) throw new HttpError(404, "unknown_repo", `No registered repository ${repoId}`);
    if (!isDirectory(row.path)) throw new HttpError(409, "repo_unavailable", `The directory of ${row.name} is gone: ${row.path}`);
    const e = this.entry(repoId);
    if (e.ctx) return e.ctx;
    e.load ??= Promise.resolve()
      .then(() => this.deps.createContext(row))
      .then(
        (ctx) => {
          e.ctx = ctx;
          if (e.error !== null) {
            // A previous load failed: its error must not outlive this success.
            e.error = null;
            this.changed(repoId);
          }
          return ctx;
        },
        (err: unknown) => {
          e.load = undefined;
          e.error = errorMessage(err);
          this.changed(repoId);
          throw err;
        },
      );
    return e.load;
  }

  /**
   * Loads and activates the repository (memoised). It first re-takes its legacy lock: a pre-M7 server
   * of that repository must not run beside its engine. A failure is stored as the summary's `error` and
   * cleared from the memo, so the next trigger retries; it is thrown as a 500 activation_failed. A
   * context whose repository started being removed while it loaded is never activated (its legacy lock
   * would outlive the removal): the call waits for the removal and starts over (404 once it is gone).
   */
  async activate(repoId: string): Promise<RepoContext> {
    const ctx = await this.load(repoId);
    const e = this.entries.get(repoId);
    if (!e || e.ctx !== ctx || e.disposing) {
      await e?.disposing?.catch(() => undefined);
      return this.activate(repoId);
    }
    this.assertOpen();
    e.activation ??= (async () => {
      this.deps.legacyLocks.hold(ctx.repo.path);
      await ctx.activate();
    })().then(
      () => {
        e.active = true;
        e.error = null;
        this.changed(repoId);
      },
      (err: unknown) => {
        e.activation = undefined;
        e.error = errorMessage(err);
        this.changed(repoId);
        throw new HttpError(500, "activation_failed", `Could not activate ${ctx.repo.name}: ${errorMessage(err)}`);
      },
    );
    await e.activation;
    return ctx;
  }

  /**
   * Forgets a repository (DESIGN §4.2): 409 repo_active while it has a running run unless `force`.
   * Disposes its context (engine shutdown: only its own PTYs, its runs paused and resumable), then
   * deletes the row, releases its legacy lock and emits repo:removed. Never deletes files, runs,
   * worktrees or branches: re-adding the path gives the same id and its history back.
   */
  async remove(repoId: string, opts: { force?: boolean } = {}): Promise<void> {
    const pending = this.entries.get(repoId)?.disposing;
    if (pending) return pending;
    const row = this.row(repoId);
    if (!row) throw new HttpError(404, "unknown_repo", `No registered repository ${repoId}`);
    if (!opts.force && this.deps.store.listRunsByStatus(["running"], { repoPath: row.path }).length > 0) {
      throw new HttpError(409, "repo_active", `${row.name} has a running run; pass force to stop it`);
    }
    const e = this.entry(repoId);
    e.disposing = (async () => {
      try {
        const ctx = e.ctx ?? (await e.load?.catch(() => undefined));
        await ctx?.dispose();
      } finally {
        this.deps.store.deleteRepo(repoId);
        this.deps.legacyLocks.release(row.path);
        this.entries.delete(repoId);
        this.deps.bus.emit("repo:removed", { repoId });
      }
    })();
    return e.disposing;
  }

  /**
   * DESIGN §4.4, until it has committed once (`meta.repos_backfilled`): normalises `runs.repo_path` and
   * `graph_meta.repo_path` to their realpath where that differs and exists, and registers every distinct
   * run path that is still a git top level and not a lane worktree, in one transaction. The git checks run before it.
   */
  async backfill(): Promise<void> {
    const { store } = this.deps;
    if (store.getMeta(REPOS_BACKFILLED_KEY) === "1") return;
    const realOf = (p: string): string | null => {
      try {
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    };
    const rewrites = new Map<string, string>();
    for (const p of new Set([...store.distinctRunRepoPaths(), ...store.distinctGraphMetaRepoPaths()])) {
      const real = realOf(p);
      if (real && real !== p) rewrites.set(p, real);
    }
    const candidates = new Set(store.distinctRunRepoPaths().map((p) => rewrites.get(p) ?? p));
    const topLevels: string[] = [];
    for (const p of candidates) {
      if (!isDirectory(p) || isInWorktreesDir(this.deps.paths, p)) continue;
      try {
        if (realOf(await resolveRepoRoot(p)) === p) topLevels.push(p);
      } catch {
        // Not a git repository any more.
      }
    }
    store.transaction(() => {
      for (const [from, to] of rewrites) store.rewriteRepoPath(from, to);
      const now = this.now();
      for (const p of topLevels) {
        if (store.getRepoByPath(p)) continue;
        const id = repoIdFor(p);
        if (store.getRepo(id)) continue;
        store.insertRepo({ id, path: p, name: path.basename(p), addedAt: now, lastOpenedAt: null });
      }
      store.setMeta(REPOS_BACKFILLED_KEY, "1");
    });
  }

  /**
   * Daemon stop: from now on load/activate/add answer 503 daemon_stopping, and every loaded repository's
   * context is disposed concurrently.
   */
  async shutdownAll(): Promise<void> {
    this.closing = true;
    const pending = [...this.entries.values()].map(async (e) => {
      await e.disposing?.catch(() => undefined);
      const ctx = e.ctx ?? (await e.load?.catch(() => undefined));
      await ctx?.dispose();
    });
    await Promise.allSettled(pending);
  }
}
