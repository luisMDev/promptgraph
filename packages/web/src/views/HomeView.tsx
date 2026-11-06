import { isFinalRunStatus, webRoutes, type GraphListItem, type RepoSummary, type RunSummary } from "@promptgraph/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ApiRequestError, errorMessage, repoApi } from "../api/rest";
import { Icons } from "../components/common/icons";
import { Logo } from "../components/common/Logo";
import { FolderBrowser, PathInput, splitTypedPath } from "../components/home/FolderPicker";
import { Modal, Button } from "../components/common/ui";
import { useTabContext } from "../components/tabs/tab-context";
import { formatDateTime } from "../lib/format";
import { RUN_STATUS_STYLE } from "../lib/status-style";
import { Link } from "../lib/router/Link";
import { useLocation } from "../lib/router/location";
import { useDaemonStore } from "../store/daemon-store";
import { removeRepository } from "../store/live";

/** Graph links shown per repository before "+N more". */
const MAX_GRAPH_LINKS = 4;

/**
 * Home (DESIGN §13.3): a centred column on the window frame (no inset panel, §13.4). One card holds Add repository
 * (a path field with folder suggestions and a folder browser) and, below it, every registered repository with its
 * availability, counters, last run and links to its graphs and active runs; a row opens its repository, Remove sits
 * on hover. The daemon's version and prerequisite warnings sit above. It updates live from `repo:status` /
 * `repo:removed` (through the daemon store).
 */
export function HomeView() {
  const repos = useDaemonStore((s) => s.repos);
  const reposError = useDaemonStore((s) => s.reposError);
  const info = useDaemonStore((s) => s.info);
  const [removing, setRemoving] = useState<RepoSummary | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Centred while it fits; taller content scrolls from the top. */}
      <div className="flex min-h-full flex-col px-6 py-10">
        <div className="mx-auto my-auto w-full max-w-2xl space-y-4">
          <header className="flex items-end justify-between gap-4 px-1">
            <div className="flex items-center gap-3">
              <Logo size={28} />
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-foreground">promptgraph</h1>
                <p className="text-xs text-muted-foreground">Open a repository to design and run its graphs.</p>
              </div>
            </div>
            {info && <span className="font-mono text-[11px] text-muted-foreground">v{info.version}</span>}
          </header>

          {info && info.warnings.length > 0 && (
            <Alert className="border-amber-500/30 bg-amber-500/10">
              <Icons.alert className="text-amber-700" />
              <AlertDescription className="space-y-0.5 text-xs text-amber-700!">
                {info.warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </AlertDescription>
            </Alert>
          )}

          <section aria-label="Repositories" className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <AddRepository />
            <div className="flex items-center justify-between border-t px-4 pt-3 pb-2">
              <h2 className="text-xs font-medium text-muted-foreground">Repositories</h2>
              {repos && repos.length > 0 && <span className="text-[11px] text-muted-foreground tabular-nums">{repos.length}</span>}
            </div>
            {reposError && (
              <p role="alert" className="px-4 pb-3 text-xs text-red-700">
                Could not list the repositories: {reposError}
              </p>
            )}
            {repos === null && !reposError && <p className="px-4 pt-2 pb-6 text-center text-xs text-muted-foreground">Loading…</p>}
            {repos?.length === 0 && <EmptyState />}
            {repos && repos.length > 0 && (
              <ul className="divide-y">
                {repos.map((repo) => (
                  <RepoRow key={repo.id} repo={repo} onRemove={() => setRemoving(repo)} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      {removing && <RemoveDialog repo={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-4 pb-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icons.folder />
      </div>
      <p className="text-sm font-medium text-foreground">No repositories yet</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Add one above, or run <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">promptgraph</code> inside a git repository.
      </p>
    </div>
  );
}

function RepoRow({ repo, onRemove }: { repo: RepoSummary; onRemove: () => void }) {
  const running = repo.runs.running + repo.runs.paused;
  return (
    <li className="group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/40" aria-label={repo.name}>
      <RepoAvatar repo={repo} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/* The name's link covers the whole row (after:inset-0); the links and buttons inside sit above it. */}
          <Link
            to={webRoutes.repo(repo.id)}
            aria-label={`Open ${repo.name}`}
            className="truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          >
            {repo.name}
          </Link>
          {!repo.available && <Badge className="h-4 bg-red-500/15 px-1.5 text-[10px] font-normal text-red-700">unavailable</Badge>}
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={repo.path}>
          {repo.path}
        </p>
        {repo.error && (
          <p role="alert" className="mt-1 text-xs text-red-700">
            {repo.error}
          </p>
        )}
        {repo.available && <RepoLinks repo={repo} active={running} />}
      </div>
      <div className="relative flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-center gap-1">
          <Counters repo={repo} />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${repo.name}`}
            title="Remove from promptgraph"
            className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onRemove}
          >
            <Icons.trash />
          </Button>
        </div>
        <span className="text-[11px] text-muted-foreground">{repo.lastRunAt ? `Last run ${formatDateTime(repo.lastRunAt)}` : "No runs yet"}</span>
      </div>
    </li>
  );
}

/** The repository's initial on a tile; red when the repository is unavailable. */
function RepoAvatar({ repo }: { repo: RepoSummary }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold uppercase",
        repo.available ? "bg-muted text-foreground/80" : "bg-red-500/15 text-red-700",
      )}
    >
      {repo.name.charAt(0) || "?"}
    </div>
  );
}

function Counters({ repo }: { repo: RepoSummary }) {
  const items: { label: string; value: number; className: string }[] = [
    { label: "running", value: repo.runs.running, className: "bg-blue-500/15 text-blue-700" },
    { label: "paused", value: repo.runs.paused, className: "bg-amber-500/15 text-amber-700" },
    { label: "awaiting approval", value: repo.waiting.approval, className: "bg-violet-500/15 text-violet-700" },
    { label: "waiting for input", value: repo.waiting.input, className: "bg-amber-500/15 text-amber-700" },
  ];
  const shown = items.filter((i) => i.value > 0);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {shown.map((i) => (
        <Badge key={i.label} className={`h-5 px-1.5 text-[10px] font-normal ${i.className}`}>
          {i.value} {i.label}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Links to the repository's active runs and graphs (loaded with plain GETs, which never activate it). Home
 * subscribes to no repository, so they are refetched when its tab becomes visible again and after a
 * reconnect (DESIGN §13.5), besides on a new run; a hidden Home fetches nothing, a failed refetch keeps
 * the links it had.
 */
function RepoLinks({ repo, active }: { repo: RepoSummary; active: number }) {
  const [graphs, setGraphs] = useState<GraphListItem[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const tabActive = useTabContext()?.active ?? true;
  const online = useDaemonStore((s) => s.connection !== "reconnecting" && s.connection !== "unreachable");
  const version = `${repo.lastRunAt}|${active}`;
  useEffect(() => {
    if (!tabActive || !online) return;
    let cancelled = false;
    const api = repoApi(repo.id);
    api.listGraphs().then(
      (r) => !cancelled && setGraphs(r.graphs),
      () => !cancelled && setGraphs((g) => g ?? []),
    );
    if (active > 0)
      api.listRuns(undefined, 20).then(
        (r) => !cancelled && setRuns(r.runs.filter((x) => !isFinalRunStatus(x.status))),
        () => undefined,
      );
    else setRuns([]);
    return () => {
      cancelled = true;
    };
  }, [repo.id, version, active, tabActive, online]);
  if (!graphs?.length && !runs.length) return null;
  const shownGraphs = graphs?.slice(0, MAX_GRAPH_LINKS) ?? [];
  const more = (graphs?.length ?? 0) - shownGraphs.length;
  const chip = "relative inline-flex max-w-48 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {runs.map((r) => (
        <Link key={r.id} to={webRoutes.run(repo.id, r.id)} className={cn(chip, "bg-muted text-foreground hover:bg-accent")}>
          <span className={`size-1.5 shrink-0 rounded-full ${RUN_STATUS_STYLE[r.status].dot}`} />
          <span className="truncate">
            {r.graphName} #{r.shortId}
          </span>
        </Link>
      ))}
      {shownGraphs.map((g) => (
        <Link key={g.id} to={webRoutes.graph(repo.id, g.id)} className={cn(chip, "text-muted-foreground hover:bg-accent hover:text-foreground")}>
          <Icons.layers className="shrink-0 text-[11px]" />
          <span className="truncate">{g.name ?? g.id}</span>
        </Link>
      ))}
      {more > 0 && <span className="px-1 text-[11px] text-muted-foreground">+{more} more</span>}
    </div>
  );
}

const ADD_ERRORS: Record<string, string> = {
  path_not_absolute: "Enter an absolute path (or one starting with ~/).",
  not_a_git_repo: "That directory is not inside a git repository.",
  lane_worktree: "That is a promptgraph lane worktree; add the repository it belongs to.",
};

function AddRepository() {
  const { navigate } = useLocation();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const add = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const repo = await useDaemonStore.getState().addRepo(value.trim());
      setPath("");
      navigate(webRoutes.repo(repo.id));
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.body.code : undefined;
      setError((code && ADD_ERRORS[code]) ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void add(path);
  };
  return (
    <div className="space-y-2 bg-muted/30 p-4">
      <h2 className="text-xs font-medium text-muted-foreground">Add a repository</h2>
      <form className="flex items-center gap-2" onSubmit={submit}>
        <PathInput value={path} onChange={setPath} disabled={busy} inputClassName="h-9 bg-background" />
        <Button className="h-9" onClick={() => setBrowsing(true)} disabled={busy}>
          <Icons.folder /> Browse…
        </Button>
        <Button type="submit" variant="primary" className="h-9" disabled={busy || !path.trim()}>
          <Icons.plus /> Add
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Tab completes folder names. Graphs in a repository can run commands on this machine: add only repositories you trust.
      </p>
      {browsing && (
        <FolderBrowser
          initialPath={splitTypedPath(path) ? path : undefined}
          onClose={() => setBrowsing(false)}
          onSelect={(p) => {
            setBrowsing(false);
            setPath(p);
            void add(p);
          }}
        />
      )}
    </div>
  );
}

/** Remove (DESIGN §4.2): a 409 while a run is active is explained, with "Remove anyway" (force). */
function RemoveDialog({ repo, onClose }: { repo: RepoSummary; onClose: () => void }) {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await removeRepository(repo.id, force);
      onClose();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) setActive(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Remove ${repo.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {active ? (
            <Button variant="danger" disabled={busy} onClick={() => void remove(true)}>
              Remove anyway
            </Button>
          ) : (
            <Button variant="danger" disabled={busy} onClick={() => void remove(false)}>
              Remove
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>promptgraph forgets this repository. Its files, graphs and run history stay where they are; you can add it again.</p>
        {active && (
          <p role="alert" className="text-amber-700">
            A run of this repository is active. Removing it anyway interrupts the run.
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
