import { graphNameForIssue, type GraphIssue } from "@promptgraph/shared";
import { useId, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { LinearIssuePicker } from "./LinearIssuePicker";

/** What the new-graph dialog creates: a name, and the Linear issues it is linked to (DESIGN §24). */
export interface GraphNameValue {
  name: string;
  issues: GraphIssue[];
}

/** The name the dialog proposes for these issues: the first one's ("ENG-123 Title"), or none. */
function autoName(issues: readonly GraphIssue[]): string {
  return issues[0] ? graphNameForIssue(issues[0]) : "";
}

/**
 * The new-graph dialog's fields (DESIGN §24.2): the name and, while Linear is connected, the linked issues
 * (LinearIssuePicker: a list and a search dialog). Linking issues fills the name with the first one's
 * ("ENG-123 Title") until the user types a name of their own. Enter in the name field submits.
 */
export function GraphNameField({ value, onChange, onSubmit }: { value: GraphNameValue; onChange: (v: GraphNameValue) => void; onSubmit: () => void }) {
  const nameId = useId();
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    onSubmit();
  };
  const setIssues = (issues: GraphIssue[]) => {
    const auto = value.name.trim() === "" || value.name === autoName(value.issues);
    onChange({ name: auto ? autoName(issues) : value.name, issues });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={nameId} className="block text-xs font-medium text-muted-foreground">
          Name
        </label>
        <Input id={nameId} autoFocus autoComplete="off" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} onKeyDown={onNameKey} />
      </div>
      <LinearIssuePicker selected={value.issues} onChange={setIssues} />
    </div>
  );
}
