import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { laneLegend } from "../../lib/lanes";
import { useRun } from "../../store/view/context";
import { LaneBadge } from "../common/LaneBadge";
import { Section } from "../common/ui";

/** Run panel legend: one row per lane (colour, id, branch, state, pushed, workspace setup), plan order. */
export function LaneLegend() {
  const detail = useRun((s) => s.detail);
  const lanes = useRun((s) => s.lanes);
  const currentByNode = useRun((s) => s.currentByNode);
  const entries = useMemo(() => (detail ? laneLegend(detail.run.graphSnapshot, lanes, currentByNode) : []), [detail, lanes, currentByNode]);
  if (entries.length === 0) return null;
  return (
    <Section title={`Lanes (${entries.length})`}>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.id} className="space-y-0.5 text-xs">
            <div className="flex items-center gap-2">
              <LaneBadge id={e.id} index={e.index} />
              {e.lane ? (
                <span className="min-w-0 truncate font-mono text-foreground/85" title={e.lane.worktreePath}>
                  {e.lane.branch}
                </span>
              ) : (
                <span className="text-muted-foreground italic">not created yet</span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {e.setup === "running" && <span className="text-blue-700">setting up…</span>}
                {e.setup === "failed" && <span className="text-red-700">setup failed</span>}
                {e.lane?.pushed && <Badge className="h-auto rounded bg-indigo-500/20 px-1 py-0 text-[10px] font-normal text-indigo-700">pushed</Badge>}
                {e.lane && e.lane.status !== "active" && <span className="text-muted-foreground">{e.lane.status}</span>}
              </span>
            </div>
            {e.nodeLabels.length > 0 && <p className="truncate pl-1 text-[11px] text-muted-foreground" title={e.nodeLabels.join(" → ")}>{e.nodeLabels.join(" → ")}</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
