import { Separator } from "@/components/ui/separator";
import { DEFAULT_BRIEF_MODEL, resolveBranchPrefix, type GraphSettings, type KeepWorktrees } from "@promptgraph/shared";
import { CompletionEditor, EFFORT_OPTIONS, InheritSelect, MODEL_SUGGESTIONS, PERMISSION_OPTIONS } from "../inspector/ClaudeOptions";
import { LinesInput, OptionalNumber, OptionalText, Select, TextArea } from "../common/fields";
import { useId } from "react";
import { useRepo, useView } from "../../store/view/context";
import { Checkbox, Field } from "../common/ui";

const KEEP_OPTIONS: readonly { value: KeepWorktrees; label: string }[] = [
  { value: "on-failure", label: "Keep on failure" },
  { value: "always", label: "Always keep" },
  { value: "never", label: "Always remove" },
];

const EMPTY: string[] = [];

/** Graph settings (§6): base branch, branch prefix, parallelism, workspace setup, Claude defaults, cleanup. */
export function GraphSettingsForm({ graphId, settings, disabled }: { graphId: string; settings: GraphSettings; disabled: boolean }) {
  const view = useView();
  const branches = useRepo((s) => s.info?.branches ?? EMPTY);
  const modelsListId = useId();
  const update = (patch: Partial<GraphSettings>) => view.editor.getState().updateSettings((s) => ({ ...s, ...patch }));
  const updateDefaults = (patch: Partial<GraphSettings["defaults"]>) =>
    view.editor.getState().updateSettings((s) => ({ ...s, defaults: { ...s.defaults, ...patch } }));
  // promptgraph's own lane branches (default prefix "pg/", or this graph's prefix) are not base branches.
  const lanePrefixes = ["pg/", `${resolveBranchPrefix({ id: graphId, settings })}/`];
  const baseBranches = branches.filter((b) => !lanePrefixes.some((p) => b.startsWith(p)));
  const branchOptions = baseBranches.includes(settings.baseBranch) ? baseBranches : [settings.baseBranch, ...baseBranches];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Base branch">
          <Select<string> value={settings.baseBranch} disabled={disabled} options={branchOptions.map((b) => ({ value: b, label: b }))} onChange={(baseBranch) => update({ baseBranch })} />
        </Field>
        <Field label="Max parallel Claude">
          <OptionalNumber
            value={settings.maxParallelClaude}
            min={1}
            max={16}
            disabled={disabled}
            onChange={(n) => update({ maxParallelClaude: Math.min(16, Math.max(1, Math.round(n ?? 3))) })}
          />
        </Field>
      </div>
      <Field label="Branch prefix">
        <OptionalText value={settings.branchPrefix || undefined} mono placeholder={`pg/${graphId}`} disabled={disabled} onChange={(p) => update({ branchPrefix: p ?? "" })} />
      </Field>
      <Field label="Workspace setup" hint="Runs once in each new worktree, e.g. pnpm install.">
        <TextArea value={settings.workspaceSetup ?? ""} rows={2} mono disabled={disabled} placeholder="pnpm install" onChange={(v) => update({ workspaceSetup: v.trim() ? v : undefined })} />
      </Field>
      <Field label="Worktrees after the run">
        <Select value={settings.keepWorktrees} options={KEEP_OPTIONS} disabled={disabled} onChange={(keepWorktrees) => update({ keepWorktrees })} />
      </Field>
      <Checkbox
        checked={settings.autoTrustWorktrees}
        disabled={disabled}
        label="Pre-trust worktrees in Claude Code"
        onChange={(autoTrustWorktrees) => update({ autoTrustWorktrees })}
      />
      <Checkbox
        checked={settings.allowPrWithoutApproval}
        disabled={disabled}
        label="Allow PR nodes without approval"
        onChange={(allowPrWithoutApproval) => update({ allowPrWithoutApproval })}
      />

      <Checkbox
        checked={settings.brief.enabled}
        disabled={disabled}
        label="Run brief: summarise each step"
        onChange={(enabled) => update({ brief: { ...settings.brief, enabled } })}
      />
      {settings.brief.enabled && (
        <Field label="Brief model" hint="After each step a short Claude call writes its summary in the run's timeline; its cost counts in the run.">
          <OptionalText
            value={settings.brief.model}
            list={modelsListId}
            placeholder={DEFAULT_BRIEF_MODEL}
            disabled={disabled}
            onChange={(model) => update({ brief: { ...settings.brief, model } })}
          />
        </Field>
      )}

      <Separator className="mt-1" />
      <h4 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Claude defaults</h4>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Model">
          <OptionalText value={settings.defaults.model} list={modelsListId} placeholder="Claude Code default" disabled={disabled} onChange={(model) => updateDefaults({ model })} />
          <datalist id={modelsListId}>
            {MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Effort">
          <InheritSelect value={settings.defaults.effort} options={EFFORT_OPTIONS} inherited={undefined} disabled={disabled} onChange={(effort) => updateDefaults({ effort })} />
        </Field>
      </div>
      <Field label="Permission mode">
        <Select value={settings.defaults.permissionMode} options={PERMISSION_OPTIONS} disabled={disabled} onChange={(permissionMode) => updateDefaults({ permissionMode })} />
      </Field>
      <Field label="Allowed tools" hint="One per line.">
        <LinesInput key={graphId} value={settings.defaults.allowedTools} disabled={disabled} placeholder="Bash(pnpm test:*)" onChange={(allowedTools) => updateDefaults({ allowedTools })} />
      </Field>
      <CompletionEditor value={settings.defaults.completion} disabled={disabled} onChange={(completion) => updateDefaults({ completion })} />
    </div>
  );
}
