import type { DiffResponse, DiffScope } from "@promptgraph/shared";
import { useEffect, useState } from "react";
import { errorMessage } from "../../api/rest";
import { useView } from "../../store/view/context";
import type { DiffTarget } from "../../store/view/ui-store";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Modal } from "../common/ui";
import { DiffView } from "./DiffView";

/**
 * Diff dialog: what one node changed (§9.7, between its start and end snapshots) with a switch to its
 * whole lane, or a lane of a run (from the report). Loaded lazily (with diff2html) by App.
 */
export function DiffDialog({ target }: { target: DiffTarget }) {
  const view = useView();
  const close = () => view.ui.getState().openDiff(null);
  const [scope, setScope] = useState<DiffScope>("node");
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    const load = target.kind === "node" ? view.api.diff(target.nodeRunId, scope) : view.api.laneDiff(target.runId, target.laneId);
    load.then(
      (d) => !cancelled && setDiff(d),
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [target, scope, view.api]);

  const nodeScope = target.kind === "node" && scope === "node";
  return (
    <Modal title={target.title} onClose={close} wide>
      <div className="space-y-3">
        {target.kind === "node" && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Diff scope"
            value={scope}
            // Ignore the deselect ("") so one scope is always selected.
            onValueChange={(v) => v && setScope(v as DiffScope)}
          >
            <ToggleGroupItem value="node" className="text-xs" title="What this step changed, from when it started to when it finished">
              This step
            </ToggleGroupItem>
            <ToggleGroupItem value="lane" className="text-xs" title="Everything the lane changed since the base branch">
              Whole lane
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">Could not load the diff: {error}</AlertDescription>
          </Alert>
        ) : diff ? (
          <DiffView
            diff={diff}
            title={nodeScope ? "Changes made by this step" : undefined}
            emptyText={nodeScope ? "This step changed no files." : "No changes in this lane."}
          />
        ) : (
          <p className="text-xs text-muted-foreground">Loading diff…</p>
        )}
      </div>
    </Modal>
  );
}
