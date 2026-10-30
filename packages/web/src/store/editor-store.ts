import type { Graph, ValidationResult } from "@promptgraph/shared";

/** Graph being edited (canvas/palette/inspector). Autosave debounced 500ms (§11.1); validation re-run on change. */
export interface EditorState {
  graph: Graph | null;
  graphHash: string | null;
  modifiedOutside: boolean;
  dirty: boolean;
  saving: boolean;
  validation: ValidationResult;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
}
