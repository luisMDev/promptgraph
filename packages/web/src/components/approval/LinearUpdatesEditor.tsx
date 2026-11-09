import type { ApprovalInfoResponse, LinearUpdateDecision, LinearUpdateProposal } from "@promptgraph/shared";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Select } from "../common/fields";
import { IssueStateDot } from "../common/LinearIssueLink";
import { Checkbox, Field } from "../common/ui";

/** One proposal as edited in the approval dialog. */
export interface LinearUpdateDraft {
  issueId: string;
  apply: boolean;
  comment: string;
  stateId: string | null;
}

/** Drafts from the proposals: an issue is applied when Claude proposed something for it. */
export function draftsOf(proposals: readonly LinearUpdateProposal[]): LinearUpdateDraft[] {
  return proposals.map((p) => ({ issueId: p.issueId, apply: p.comment.trim() !== "" || p.stateId !== null, comment: p.comment, stateId: p.stateId }));
}

/** What the approval sends (ApprovalRequest.linearUpdates): the drafts to apply. */
export function decisionsOf(drafts: readonly LinearUpdateDraft[]): LinearUpdateDecision[] {
  return drafts.filter((d) => d.apply).map(({ issueId, comment, stateId }) => ({ issueId, comment, stateId }));
}

const KEEP = "";

/**
 * The proposed Linear updates of a `linear` gate (DESIGN §24.5): per linked issue, whether to apply it, the progress
 * comment (Markdown) and the new state (Keep = no change), each editable while the gate waits. Kinds the node does not
 * allow are not shown.
 */
export function LinearUpdatesEditor({
  linear,
  drafts,
  disabled,
  onChange,
}: {
  linear: NonNullable<ApprovalInfoResponse["linear"]>;
  drafts: readonly LinearUpdateDraft[];
  disabled: boolean;
  onChange: (drafts: LinearUpdateDraft[]) => void;
}) {
  const set = (issueId: string, patch: Partial<LinearUpdateDraft>) => onChange(drafts.map((d) => (d.issueId === issueId ? { ...d, ...patch } : d)));
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Nothing is sent to Linear until you approve. Comments are posted as the owner of the Linear API key.</p>
      <ul aria-label="Proposed Linear updates" className="space-y-2">
        {linear.proposals.map((p) => {
          const d = drafts.find((x) => x.issueId === p.issueId);
          if (!d) return null;
          const stateOptions = [{ value: KEEP, label: `Keep (${p.currentState?.name ?? "unknown"})` }, ...p.states.filter((s) => s.id !== p.currentState?.id).map((s) => ({ value: s.id, label: s.name }))];
          return (
            <li key={p.issueId} aria-label={p.identifier} className={cn("space-y-2 rounded-md border p-3", !d.apply && "opacity-60")}>
              <div className="flex items-center gap-2 text-sm">
                <Checkbox checked={d.apply} disabled={disabled} label={`Update ${p.identifier}`} onChange={(apply) => set(p.issueId, { apply })} />
                <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-muted-foreground hover:underline" title={p.title}>
                  {p.title}
                </a>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <IssueStateDot state={p.currentState} />
                  {p.currentState?.name ?? "unknown state"}
                </span>
              </div>
              {d.apply && (
                <div className="space-y-2 pl-6">
                  {linear.allowComments && (
                    <Field label="Comment" hint="Markdown. Empty: no comment.">
                      <Textarea
                        className="field-sizing-fixed min-h-0 resize-y leading-relaxed"
                        rows={4}
                        value={d.comment}
                        disabled={disabled}
                        onChange={(e) => set(p.issueId, { comment: e.target.value })}
                      />
                    </Field>
                  )}
                  {linear.allowStateChanges && (
                    <Field label="State">
                      <Select value={d.stateId ?? KEEP} options={stateOptions} disabled={disabled} onChange={(v) => set(p.issueId, { stateId: v === KEEP ? null : v })} />
                    </Field>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
