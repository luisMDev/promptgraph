import { useMemo } from "react";
import { laneLegend } from "../../lib/lanes";
import { useRunStore } from "../../store/run-store";
import { LaneBadge } from "../common/LaneBadge";
import { Section } from "../common/ui";

/** Run panel legend: one row per lane (colour, id, branch, state, pushed, workspace setup), plan order. */
export function LaneLegend() {
  const detail = useRunStore((s) => s.detail);
  const lanes = useRunStore((s) => s.lanes);
  const currentByNode = useRunStore((s) => s.currentByNode);
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
                <span className="min-w-0 truncate font-mono text-zinc-300" title={e.lane.worktreePath}>
                  {e.lane.branch}
                </span>
              ) : (
                <span className="text-zinc-500 italic">not created yet</span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {e.setup === "running" && <span className="text-blue-300">setting up…</span>}
                {e.setup === "failed" && <span className="text-red-300">setup failed</span>}
                {e.lane?.pushed && <span className="rounded bg-indigo-500/20 px-1 text-[10px] text-indigo-200">pushed</span>}
                {e.lane && e.lane.status !== "active" && <span className="text-zinc-500">{e.lane.status}</span>}
              </span>
            </div>
            {e.nodeLabels.length > 0 && <p className="truncate pl-1 text-[11px] text-zinc-500" title={e.nodeLabels.join(" → ")}>{e.nodeLabels.join(" → ")}</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
