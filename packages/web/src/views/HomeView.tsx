import { isFinalRunStatus, webRoutes, type GraphListItem, type RepoSummary, type RunSummary } from "@promptgraph/shared";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ApiRequestError, errorMessage, repoApi } from "../api/rest";
import { Icons } from "../components/common/icons";
import { FolderBrowser, PathInput, splitTypedPath } from "../components/home/FolderPicker";
import { Modal, Button } from "../components/common/ui";
import { Logo } from "../components/header/Header";
import { useTabContext } from "../components/tabs/tab-context";
import { formatDateTime } from "../lib/format";
import { RUN_STATUS_STYLE } from "../lib/status-style";
import { Link } from "../lib/router/Link";
import { useLocation } from "../lib/router/location";
import { useDaemonStore } from "../store/daemon-store";
import { removeRepository } from "../store/live";

/**
 * Home (DESIGN §13.3): every registered repository with its availability, counters, last run and links to its
 * graphs and active runs; Add repository (a path field with folder suggestions and a folder browser), Remove; the daemon's version and prerequisite warnings. It updates
 * live from `repo:status` / `repo:removed` (through the daemon store).
 */
export function HomeView() {
  const repos = useDaemonStore((s) => s.repos);
  const reposError = useDaemonStore((s) => s.reposError);
  const info = useDaemonStore((s) => s.info);
  const [removing, setRemoving] = useState<RepoSummary | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-card/80 px-3">
        <Logo />
        <h1 className="text-[15px] font-semibold tracking-tight text-foreground">promptgraph</h1>
        {info && <span className="ml-auto font-mono text-xs text-muted-foreground">v{info.version}</span>}
      </header>
      <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-6">
        {info && info.warnings.length > 0 && (
          <Alert className="border-amber-500/30 bg-amber-500/10">
            <AlertDescription className="space-y-1 text-xs text-amber-700!">
              {info.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </AlertDescription>
          </Alert>
        )}

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">Repositories</h2>
          {reposError && <p className="text-xs text-red-700">Could not list the repositories: {reposError}</p>}
          {repos === null && !reposError && <p className="text-xs text-muted-foreground">Loading…</p>}
          {repos?.length === 0 && <p className="text-xs text-muted-foreground">No repository yet: add one below, or run `promptgraph` in a git repository.</p>}
          <ul className="space-y-2">
            {repos?.map((repo) => (
              <RepoRow key={repo.id} repo={repo} onRemove={() => setRemoving(repo)} />
            ))}
          </ul>
        </section>

        <AddRepository />
      </div>
      {removing && <RemoveDialog repo={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function RepoRow({ repo, onRemove }: { repo: RepoSummary; onRemove: () => void }) {
  const running = repo.runs.running + repo.runs.paused;
  return (
    <li className="rounded-md border bg-card px-4 py-3" aria-label={repo.name}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link to={webRoutes.repo(repo.id)} className="truncate text-sm font-medium text-foreground hover:underline">
              {repo.name}
            </Link>
            {!repo.available && <Badge className="h-4 bg-red-500/15 px-1.5 text-[10px] font-normal text-red-700">unavailable</Badge>}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={repo.path}>
            {repo.path}
          </p>
        </div>
        <Counters repo={repo} />
        <Link to={webRoutes.repo(repo.id)} className="rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-accent" aria-label={`Open ${repo.name}`}>
          Open
        </Link>
        <Button size="sm" variant="ghost" aria-label={`Remove ${repo.name}`} onClick={onRemove}>
          <Icons.trash />
        </Button>
      </div>
      {repo.error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {repo.error}
        </p>
      )}
      <div className="mt-1 text-[11px] text-muted-foreground">{repo.lastRunAt ? `Last run ${formatDateTime(repo.lastRunAt)}` : "No runs yet"}</div>
      {repo.available && <RepoLinks repo={repo} active={running} />}
    </li>
  );
}

function Counters({ repo }: { repo: RepoSummary }) {
  const items: { label: string; value: number; className: string }[] = [
    { label: "running", value: repo.runs.running, className: "bg-blue-500/15 text-blue-700" },
    { label: "paused", value: repo.runs.paused, className: "bg-amber-500/15 text-amber-700" },
    { label: "awaiting approval", value: repo.waiting.approval, className: "bg-violet-500/15 text-violet-700" },
    { label: "waiting for input", value: repo.waiting.input, className: "bg-amber-500/15 text-amber-700" },
  ];
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      {items
        .filter((i) => i.value > 0)
        .map((i) => (
          <Badge key={i.label} className={`h-5 px-1.5 text-[10px] font-normal ${i.className}`}>
            {i.value} {i.label}
          </Badge>
        ))}
    </div>
  );
}

/**
 * Links to the repository's graphs and active runs (loaded with plain GETs, which never activate it). Home
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
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {runs.map((r) => (
        <Link key={r.id} to={webRoutes.run(repo.id, r.id)} className="inline-flex items-center gap-1 text-foreground hover:underline">
          <span className={`size-1.5 rounded-full ${RUN_STATUS_STYLE[r.status].dot}`} />
          {r.graphName} #{r.shortId}
        </Link>
      ))}
      {graphs?.map((g) => (
        <Link key={g.id} to={webRoutes.graph(repo.id, g.id)} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline">
          <Icons.layers className="text-[11px]" />
          {g.name ?? g.id}
        </Link>
      ))}
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
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground">Add repository</h2>
      <form className="flex gap-2" onSubmit={submit}>
        <PathInput value={path} onChange={setPath} disabled={busy} />
        <Button onClick={() => setBrowsing(true)} disabled={busy}>
          <Icons.folder /> Browse…
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !path.trim()}>
          <Icons.plus /> Add
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <Note>Type a path (Tab completes folder names) or browse for a folder. Graphs in a repository can run commands on this machine: add only repositories you trust.</Note>
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
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-muted-foreground">{children}</p>;
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
