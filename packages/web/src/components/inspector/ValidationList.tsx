import type { ValidationIssue, ValidationResult } from "@promptgraph/shared";
import { useEditorStore } from "../../store/editor-store";
import { Icons } from "../common/icons";

/** Errors (block Run) and warnings (informational); clicking an issue selects its node/edge. */
export function ValidationList({ validation }: { validation: ValidationResult }) {
  if (!validation.errors.length && !validation.warnings.length) {
    return <p className="text-xs text-green-400/90">No problems found.</p>;
  }
  return (
    <ul className="space-y-1">
      {validation.errors.map((i, n) => (
        <IssueRow key={`e${n}`} issue={i} tone="error" />
      ))}
      {validation.warnings.map((i, n) => (
        <IssueRow key={`w${n}`} issue={i} tone="warning" />
      ))}
    </ul>
  );
}

function IssueRow({ issue, tone }: { issue: ValidationIssue; tone: "error" | "warning" }) {
  const target = issue.nodeId || issue.edgeId;
  return (
    <li>
      <button
        type="button"
        disabled={!target}
        onClick={() => useEditorStore.getState().setSelection(issue.nodeId ? [issue.nodeId] : [], issue.edgeId ? [issue.edgeId] : [])}
        className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs enabled:hover:bg-zinc-800 ${tone === "error" ? "text-red-300" : "text-amber-300"}`}
      >
        <Icons.alert className="mt-0.5 shrink-0" />
        <span>{issue.message}</span>
      </button>
    </li>
  );
}
