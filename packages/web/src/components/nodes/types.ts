import type { GraphNode, Lane, NodeRun } from "@promptgraph/shared";
import type { Node } from "@xyflow/react";

export interface NodeIssues {
  errors: string[];
  warnings: string[];
}

export interface PgNodeData extends Record<string, unknown> {
  node: GraphNode;
  /** Run mode only: the node's current node run (null before the engine created one). */
  nodeRun: NodeRun | null;
  lane: Lane | null;
  runMode: boolean;
  issues: NodeIssues;
  /** Phase 2 shows the error port on every node. */
  phase: 1 | 2;
}

export type PgFlowNode = Node<PgNodeData, "pg">;
