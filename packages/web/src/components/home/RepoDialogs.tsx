import { createEmptyGraph, webRoutes, type RepoSummary } from "@promptgraph/shared";
import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { ApiRequestError, errorMessage, repoApi } from "../../api/rest";
import { useLocation } from "../../lib/router/location";
import { useDaemonStore } from "../../store/daemon-store";
import { removeRepository } from "../../store/live";
import { uniqueGraphId } from "../../store/view/actions";
import { toast } from "../../store/toast-store";
import { Icons } from "../common/icons";
import { Button, Field, Modal } from "../common/ui";
import { FolderBrowser, PathInput, splitTypedPath } from "./FolderPicker";

const ADD_ERRORS: Record<string, string> = {
  path_not_absolute: "Enter an absolute path (or one starting with ~/).",
  not_a_git_repo: "That directory is not inside a git repository.",
  lane_worktree: "That is a promptgraph lane worktree; add the repository it belongs to.",
};

/**
 * Add a repository (DESIGN §13.3): an absolute path field (`~/…` accepted) with folder suggestions, Browse… (the
 * daemon's folder browser) and Add; on success it navigates to the repository.
 */
export function AddRepositoryForm({ className, onAdded, heading = true }: { className?: string; onAdded?: () => void; heading?: boolean }) {
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
      onAdded?.();
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
    <div className={cn("space-y-2", className)}>
      {heading && <h2 className="text-xs font-medium text-muted-foreground">Add a repository</h2>}
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

export function AddRepositoryDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Add a repository" onClose={onClose} wide>
      <AddRepositoryForm heading={false} onAdded={onClose} />
    </Modal>
  );
}

/** Remove (DESIGN §4.2): a 409 while a run is active is explained, with "Remove anyway" (force). */
export function RemoveRepoDialog({ repo, onClose }: { repo: RepoSummary; onClose: () => void }) {
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

/**
 * New graph in any registered repository: its name and, unless `repoId` fixes it, the repository. Saves an empty graph
 * on the repository's current branch and opens it.
 */
export function NewGraphDialog({ repos, repoId, onClose }: { repos: RepoSummary[]; repoId: string | null; onClose: () => void }) {
  const { navigate } = useLocation();
  const available = repos.filter((r) => r.available);
  const [target, setTarget] = useState(repoId ?? available[0]?.id ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && target !== "";
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      const api = repoApi(target);
      const [{ graphs }, info] = await Promise.all([api.listGraphs(), api.info()]);
      const id = uniqueGraphId(name, graphs.map((g) => g.id));
      await api.saveGraph(createEmptyGraph(id, name.trim(), info.currentBranch ?? "main"));
      onClose();
      navigate(webRoutes.graph(target, id));
    } catch (err) {
      toast("error", `Could not create graph: ${errorMessage(err)}`);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New graph"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        {!repoId && (
          <Field label="Repository">
            <NativeSelect value={target} onChange={(e) => setTarget(e.target.value)} className="w-full">
              {available.map((r) => (
                <NativeSelectOption key={r.id} value={r.id}>
                  {r.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
