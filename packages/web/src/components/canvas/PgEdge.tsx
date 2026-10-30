import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";

export interface PgEdgeData extends Record<string, unknown> {
  /** Validation messages, shown as a tooltip. */
  title?: string;
  label?: string;
}

export type PgFlowEdge = Edge<PgEdgeData, "pg">;

/** Bezier edge with a validation tooltip and an optional label pill. */
export function PgEdge(props: EdgeProps<PgFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const { data, style, markerEnd } = props;
  return (
    <>
      <g>
        {data?.title && <title>{data.title}</title>}
        <BaseEdge id={props.id} path={path} style={style} markerEnd={markerEnd} interactionWidth={18} />
      </g>
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-300 ring-1 ring-zinc-700"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { pg: PgEdge };
