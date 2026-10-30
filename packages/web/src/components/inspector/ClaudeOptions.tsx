import {
  MODEL_ALIASES,
  PRICE_TABLE,
  type ClaudeNode,
  type CompletionPolicy,
  type ContextMode,
  type Effort,
  type GraphDefaults,
  type PermissionMode,
} from "@promptgraph/shared";
import { LinesInput, OptionalNumber, OptionalText, Select } from "../common/fields";
import { Field } from "../common/ui";

export const MODEL_SUGGESTIONS = [...Object.keys(MODEL_ALIASES), ...Object.keys(PRICE_TABLE)];

export const EFFORT_OPTIONS: readonly { value: Effort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

/** bypassPermissions is deliberately absent (§7.6). */
export const PERMISSION_OPTIONS: readonly { value: PermissionMode; label: string }[] = [
  { value: "acceptEdits", label: "Accept edits" },
  { value: "auto", label: "Auto" },
  { value: "manual", label: "Manual (ask for everything)" },
  { value: "dontAsk", label: "Don't ask (deny unlisted tools)" },
  { value: "plan", label: "Plan" },
];

const CONTEXT_OPTIONS: readonly { value: ContextMode; label: string }[] = [
  { value: "fresh", label: "Fresh — new session + predecessor outputs" },
  { value: "resume", label: "Resume — continue predecessor's session" },
  { value: "clean", label: "Clean — only this prompt" },
];

type ClaudeOptionsValue = Pick<ClaudeNode["config"], "context" | "model" | "effort" | "permissionMode" | "allowedTools" | "completion">;

/** Context mode, model, effort, permission mode, allowed tools and completion policy for prompt/command nodes. */
export function ClaudeOptions({
  nodeId,
  value,
  defaults,
  onChange,
  disabled,
}: {
  nodeId: string;
  value: ClaudeOptionsValue;
  defaults: GraphDefaults;
  onChange: (patch: Partial<ClaudeOptionsValue>) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-3">
      <Field label="Context">
        <Select value={value.context} options={CONTEXT_OPTIONS} disabled={disabled} onChange={(context) => onChange({ context })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Model">
          <OptionalText
            value={value.model}
            list="pg-models"
            placeholder={defaults.model ? `Default (${defaults.model})` : "Default"}
            disabled={disabled}
            onChange={(model) => onChange({ model })}
          />
        </Field>
        <Field label="Effort">
          <InheritSelect value={value.effort} options={EFFORT_OPTIONS} inherited={defaults.effort} disabled={disabled} onChange={(effort) => onChange({ effort })} />
        </Field>
      </div>
      <Field label="Permission mode">
        <InheritSelect
          value={value.permissionMode}
          options={PERMISSION_OPTIONS}
          inherited={defaults.permissionMode}
          disabled={disabled}
          onChange={(permissionMode) => onChange({ permissionMode })}
        />
      </Field>
      <Field label="Allowed tools" hint={<>One per line, e.g. <code className="text-zinc-400">Bash(pnpm test:*)</code>. Empty = graph default.</>}>
        <LinesInput
          key={nodeId}
          value={value.allowedTools}
          disabled={disabled}
          placeholder={defaults.allowedTools?.join("\n") || "Bash(pnpm test:*)"}
          onChange={(allowedTools) => onChange({ allowedTools })}
        />
      </Field>
      <CompletionEditor value={value.completion} inherited={defaults.completion} disabled={disabled} onChange={(completion) => onChange({ completion })} />
      <datalist id="pg-models">
        {MODEL_SUGGESTIONS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}

/** Select with a leading "Default (x)" option mapping to undefined. */
export function InheritSelect<T extends string>({
  value,
  options,
  inherited,
  onChange,
  disabled,
}: {
  value: T | undefined;
  options: readonly { value: T; label: string }[];
  inherited: T | undefined;
  onChange: (v: T | undefined) => void;
  disabled?: boolean;
}) {
  const inheritedLabel = options.find((o) => o.value === inherited)?.label ?? "Claude Code default";
  return (
    <Select<string>
      value={value ?? ""}
      disabled={disabled}
      options={[{ value: "", label: `Default (${inheritedLabel})` }, ...options]}
      onChange={(v) => onChange(v === "" ? undefined : (v as T))}
    />
  );
}

type CompletionChoice = "" | CompletionPolicy["mode"];

const COMPLETION_LABELS: Record<CompletionPolicy["mode"], string> = {
  auto: "Auto (after grace period)",
  manual: "Manual (click Done)",
  marker: "Marker token",
};

export function describeCompletion(p: CompletionPolicy): string {
  if (p.mode === "auto") return `Auto, ${p.graceSec}s grace`;
  if (p.mode === "marker") return `Marker ${p.token}`;
  return "Manual";
}

/** Completion policy (§7.4). `inherited` set → offers "Default"; absent → the value is required (graph defaults). */
export function CompletionEditor<P extends CompletionPolicy | undefined>({
  value,
  inherited,
  onChange,
  disabled,
}: {
  value: P;
  inherited?: CompletionPolicy;
  onChange: (v: P) => void;
  disabled?: boolean;
}) {
  const choice: CompletionChoice = value?.mode ?? "";
  const options: { value: CompletionChoice; label: string }[] = [
    ...(inherited ? [{ value: "" as const, label: `Default (${describeCompletion(inherited)})` }] : []),
    ...(["auto", "manual", "marker"] as const).map((m) => ({ value: m, label: COMPLETION_LABELS[m] })),
  ];
  const set = (mode: CompletionChoice) => {
    const next: CompletionPolicy | undefined =
      mode === "" ? undefined : mode === "auto" ? { mode, graceSec: 5 } : mode === "marker" ? { mode, token: "<<PG_DONE>>" } : { mode };
    onChange(next as P);
  };
  return (
    <div className="space-y-2">
      <Field label="Completion" hint="When the node counts as done after Claude finishes a turn.">
        <Select<CompletionChoice> value={choice} options={options} disabled={disabled} onChange={set} />
      </Field>
      {value?.mode === "auto" && (
        <Field label="Grace period (seconds)" hint="Typing in the terminal during the grace period cancels auto-completion.">
          <OptionalNumber
            value={value.graceSec}
            min={0}
            max={3600}
            disabled={disabled}
            onChange={(graceSec) => onChange({ mode: "auto", graceSec: graceSec ?? 0 } as P)}
          />
        </Field>
      )}
      {value?.mode === "marker" && (
        <Field label="Marker token" hint="Done only when the last message contains this token.">
          <OptionalText value={value.token} mono disabled={disabled} onChange={(token) => onChange({ mode: "marker", token: token ?? "" } as P)} />
        </Field>
      )}
    </div>
  );
}
