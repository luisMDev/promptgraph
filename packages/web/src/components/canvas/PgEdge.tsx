import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { backEdgePath } from "../../lib/edge-path";
import type { LoopRoute } from "../../lib/loop-routing";
import type { EdgeRunState } from "../../lib/run-view";

export interface PgEdgeData extends Record<string, unknown> {
  /** Validation messages, shown as a tooltip. */
  title?: string;
  label?: string;
  /** Loop back-edge (§15.4): routed around the side of the nodes when it points backwards. */
  loop?: boolean;
  /** Loop back-edges: its own track beside the nodes (`loopRoutes`), so loops do not overlap. */
  route?: LoopRoute;
  /** Run mode, loop edges: iteration badge, e.g. "2/3". */
  badge?: string;
  /** Run mode only. */
  runState?: EdgeRunState;
  /** Run mode, loop edges: it looped back in this run (its badge stays violet even when the edge is dead now). */
  looped?: boolean;
}

export type PgFlowEdge = Edge<PgEdgeData, "pg">;

/** Bezier edge (loop back-edges routed visibly around the side) with a validation tooltip, a label pill and a loop badge. */
export function PgEdge(props: EdgeProps<PgFlowEdge>) {
  const { data, style, markerEnd } = props;
  const back = data?.loop ? backEdgePath(props, data.route) : null;
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
                ? `font-mono font-semibold ${data.runState === "dead" && !data.looped ? "bg-card text-muted-foreground ring-border" : "bg-violet-50 text-violet-700 ring-violet-500/60"}`
                : data?.loop
                  ? "bg-card text-violet-700 ring-violet-500/40"
                  : "bg-card text-foreground/80 ring-border"
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
