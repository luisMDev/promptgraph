import type { DiffResponse, DiffScope } from "@promptgraph/shared";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/rest";
import { useUiStore, type DiffTarget } from "../../store/ui-store";
import { Modal } from "../common/ui";
import { DiffView } from "./DiffView";

/**
 * Diff dialog: what one node changed (§9.7, between its start and end snapshots) with a switch to its
 * whole lane, or a lane of a run (from the report). Loaded lazily (with diff2html) by App.
 */
export function DiffDialog({ target }: { target: DiffTarget }) {
  const close = () => useUiStore.getState().openDiff(null);
  const [scope, setScope] = useState<DiffScope>("node");
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    const load = target.kind === "node" ? api.diff(target.nodeRunId, scope) : api.laneDiff(target.runId, target.laneId);
    load.then(
      (d) => !cancelled && setDiff(d),
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [target, scope]);

  const nodeScope = target.kind === "node" && scope === "node";
  return (
    <Modal title={target.title} onClose={close} wide>
      <div className="space-y-3">
        {target.kind === "node" && (
          <div className="flex rounded-md ring-1 ring-zinc-700" role="group" aria-label="Diff scope" style={{ width: "fit-content" }}>
            <ScopeButton active={scope === "node"} onClick={() => setScope("node")} title="What this step changed, from when it started to when it finished">
              This step
            </ScopeButton>
            <ScopeButton active={scope === "lane"} onClick={() => setScope("lane")} title="Everything the lane changed since the base branch">
              Whole lane
            </ScopeButton>
          </div>
        )}
        {error ? (
          <p className="text-xs text-red-300">Could not load the diff: {error}</p>
        ) : diff ? (
          <DiffView
            diff={diff}
            title={nodeScope ? "Changes made by this step" : undefined}
            emptyText={nodeScope ? "This step changed no files." : "No changes in this lane."}
          />
        ) : (
          <p className="text-xs text-zinc-500">Loading diff…</p>
        )}
      </div>
    </Modal>
  );
}

function ScopeButton({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`px-2.5 py-1 text-xs first:rounded-l-md last:rounded-r-md ${active ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
    >
      {children}
    </button>
  );
}
