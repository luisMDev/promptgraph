import type { ValidationIssue, ValidationResult } from "@promptgraph/shared";
import { useEditorStore } from "../../store/editor-store";
import { cn } from "@/lib/utils";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";

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
      <Button
        variant="ghost"
        size="sm"
        disabled={!target}
        onClick={() => useEditorStore.getState().setSelection(issue.nodeId ? [issue.nodeId] : [], issue.edgeId ? [issue.edgeId] : [])}
        className={cn(
          "h-auto w-full items-start justify-start gap-2 rounded-md px-2 py-1.5 text-left text-xs font-normal whitespace-normal hover:bg-accent disabled:opacity-100",
          tone === "error" ? "text-red-300 hover:text-red-300" : "text-amber-300 hover:text-amber-300",
        )}
      >
        <Icons.alert className="mt-0.5 shrink-0" />
        <span>{issue.message}</span>
      </Button>
    </li>
  );
}
