import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { backEdgePath } from "../../lib/edge-path";
import type { EdgeRunState } from "../../lib/run-view";

export interface PgEdgeData extends Record<string, unknown> {
  /** Validation messages, shown as a tooltip. */
  title?: string;
  label?: string;
  /** Loop back-edge (§15.4): routed below the nodes when it points backwards. */
  loop?: boolean;
  /** Run mode, loop edges: iteration badge, e.g. "2/3". */
  badge?: string;
  /** Run mode only. */
  runState?: EdgeRunState;
  /** Run mode, loop edges: it looped back in this run (its badge stays violet even when the edge is dead now). */
  looped?: boolean;
}

export type PgFlowEdge = Edge<PgEdgeData, "pg">;

/** Bezier edge (loop back-edges routed visibly underneath) with a validation tooltip, a label pill and a loop badge. */
export function PgEdge(props: EdgeProps<PgFlowEdge>) {
  const { data, style, markerEnd } = props;
  const back = data?.loop ? backEdgePath(props) : null;
  const [path, labelX, labelY] = back ?? getBezierPath(props);
  const text = data?.badge ?? data?.label;
  return (
    <>
      <g>
        {data?.title && <title>{data.title}</title>}
        <BaseEdge id={props.id} path={path} style={style} markerEnd={markerEnd} interactionWidth={18} />
      </g>
      {text && (
        <EdgeLabelRenderer>
          <div
            className={`nodrag nopan pointer-events-none absolute rounded px-1.5 py-0.5 text-[10px] ring-1 ${
              data?.badge
                ? `font-mono font-semibold ${data.runState === "dead" && !data.looped ? "bg-zinc-900 text-zinc-500 ring-zinc-700" : "bg-violet-950 text-violet-200 ring-violet-500/60"}`
                : data?.loop
                  ? "bg-zinc-900 text-violet-300 ring-violet-500/40"
                  : "bg-zinc-900 text-zinc-300 ring-zinc-700"
            }`}
            title={data?.badge ? "Times looped back / maximum" : undefined}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data?.badge ? `↺ ${data.badge}` : text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { pg: PgEdge };
