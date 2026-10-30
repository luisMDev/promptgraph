import type { ConditionEvaluator, GraphNode, GraphNodeOf, GraphSettings, NodeConfigMap, NodeType } from "@promptgraph/shared";
import { useEffect, useMemo } from "react";
import { mergeInputLabels } from "../../lib/lanes";
import { useAppStore } from "../../store/app-store";
import { useEditorStore } from "../../store/editor-store";
import { LinesInput, OptionalNumber, OptionalText, Select, TextArea, parseEnv } from "../common/fields";
import { Icons } from "../common/icons";
import { Checkbox, Field } from "../common/ui";
import { ClaudeOptions } from "./ClaudeOptions";

interface FormProps<T extends NodeType> {
  node: GraphNodeOf<T>;
  settings: GraphSettings;
  disabled: boolean;
  patch: (p: Partial<NodeConfigMap[T]>) => void;
}

/** Per-type config form; edits go through the editor store (autosaved). */
export function NodeConfigForm({ node, settings, disabled }: { node: GraphNode; settings: GraphSettings; disabled: boolean }) {
  const patch = (p: object) =>
    useEditorStore.getState().updateNode(node.id, (n) => ({ ...n, config: { ...n.config, ...p } }) as GraphNode);
  switch (node.type) {
    case "prompt":
      return <PromptForm node={node} settings={settings} disabled={disabled} patch={patch} />;
    case "command":
      return <CommandForm node={node} settings={settings} disabled={disabled} patch={patch} />;
    case "shell":
      return <ShellForm node={node} settings={settings} disabled={disabled} patch={patch} />;
    case "commit":
      return <CommitForm node={node} settings={settings} disabled={disabled} patch={patch} />;
    case "pr":
      return <PrForm node={node} settings={settings} disabled={disabled} patch={patch} />;
    case "approval":
      return <ApprovalForm node={node} settings={settings} disabled={disabled} patch={patch} />;
    case "merge":
      return <MergeForm node={node} settings={settings} disabled={disabled} patch={patch} />;
    case "condition":
      return <ConditionForm node={node} settings={settings} disabled={disabled} patch={patch} />;
  }
}

function PromptForm({ node, settings, disabled, patch }: FormProps<"prompt">) {
  return (
    <div className="space-y-3">
      <Field label="Prompt">
        <TextArea value={node.config.prompt} rows={8} disabled={disabled} placeholder="What should Claude do?" onChange={(prompt) => patch({ prompt })} />
      </Field>
      <ClaudeOptions nodeId={node.id} value={node.config} defaults={settings.defaults} disabled={disabled} onChange={patch} />
    </div>
  );
}

function CommandForm({ node, settings, disabled, patch }: FormProps<"command">) {
  const commands = useAppStore((s) => s.commands);
  useEffect(() => {
    void useAppStore.getState().loadCommands();
  }, []);
  const name = node.config.command.trim().split(/\s+/)[0] ?? "";
  const match = commands?.find((c) => c.name === name);
  return (
    <div className="space-y-3">
      <Field
        label="Slash command"
        hint={match ? (match.description ?? `${match.kind} from ${match.source}`) + (match.argumentHint ? ` · args: ${match.argumentHint}` : "") : "Pick a command or skill; arguments may follow it."}
      >
        <input
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          list="pg-commands"
          value={node.config.command}
          placeholder="/code-review high"
          disabled={disabled}
          onChange={(e) => patch({ command: e.target.value })}
        />
        <datalist id="pg-commands">
          {(commands ?? []).map((c) => (
            <option key={`${c.source}:${c.name}`} value={c.name}>
              {c.description ?? c.kind}
            </option>
          ))}
        </datalist>
      </Field>
      <ClaudeOptions nodeId={node.id} value={node.config} defaults={settings.defaults} disabled={disabled} onChange={patch} />
    </div>
  );
}

function ShellForm({ node, disabled, patch }: FormProps<"shell">) {
  const envLines = Object.entries(node.config.env ?? {}).map(([k, v]) => `${k}=${v}`);
  return (
    <div className="space-y-3">
      <Field label="Command" hint="Runs with sh -c in the lane's worktree. Fails on a non-zero exit code.">
        <TextArea value={node.config.run} rows={4} mono disabled={disabled} placeholder="pnpm test" onChange={(run) => patch({ run })} />
      </Field>
      <Field label="Timeout (seconds)">
        <OptionalNumber value={node.config.timeoutSec} min={1} placeholder="No timeout" disabled={disabled} onChange={(timeoutSec) => patch({ timeoutSec })} />
      </Field>
      <Field label="Environment" hint="KEY=VALUE, one per line.">
        <LinesInput
          key={node.id}
          value={envLines}
          disabled={disabled}
          placeholder="CI=1"
          onChange={(lines) => {
            const env = parseEnv(lines ?? []);
            patch({ env: Object.keys(env).length ? env : undefined });
          }}
        />
      </Field>
    </div>
  );
}

function CommitForm({ node, disabled, patch }: FormProps<"commit">) {
  return (
    <div className="space-y-3">
      <Checkbox
        checked={node.config.generateMessage}
        disabled={disabled}
        label="Generate the message with Claude"
        onChange={(generateMessage) => patch({ generateMessage })}
      />
      {!node.config.generateMessage && (
        <Field label="Commit message">
          <TextArea value={node.config.message ?? ""} rows={3} disabled={disabled} onChange={(m) => patch({ message: m || undefined })} />
        </Field>
      )}
      <Checkbox
        checked={node.config.squashCheckpoints}
        disabled={disabled}
        label="Squash checkpoint commits"
        onChange={(squashCheckpoints) => patch({ squashCheckpoints })}
      />
    </div>
  );
}

function PrForm({ node, settings, disabled, patch }: FormProps<"pr">) {
  const branches = useAppStore((s) => s.repo?.branches ?? []);
  return (
    <div className="space-y-3">
      <Field label="Title" hint="Leave title or body empty to generate it with Claude from the lane's changes; you can edit both when approving.">
        <OptionalText value={node.config.title} disabled={disabled} placeholder="Generated" onChange={(title) => patch({ title })} />
      </Field>
      <Field label="Body">
        <TextArea value={node.config.body ?? ""} rows={4} disabled={disabled} placeholder="Generated" onChange={(b) => patch({ body: b || undefined })} />
      </Field>
      <Field label="Base branch">
        <Select<string>
          value={node.config.base ?? ""}
          disabled={disabled}
          options={[{ value: "", label: `Graph base (${settings.baseBranch})` }, ...branches.map((b) => ({ value: b, label: b }))]}
          onChange={(b) => patch({ base: b || undefined })}
        />
      </Field>
      <Checkbox checked={node.config.draft} disabled={disabled} label="Open as draft" onChange={(draft) => patch({ draft })} />
      <Checkbox
        checked={node.config.requireApproval}
        disabled={disabled || (!settings.allowPrWithoutApproval && node.config.requireApproval)}
        label={
          <>
            Require approval before pushing
            {!settings.allowPrWithoutApproval && node.config.requireApproval && <Icons.lock className="text-zinc-500" />}
          </>
        }
        onChange={(requireApproval) => patch({ requireApproval })}
      />
      {!settings.allowPrWithoutApproval && (
        <p className="text-[11px] text-zinc-500">Nothing leaves the machine without approval. Unlock "Allow PR nodes without approval" in graph settings.</p>
      )}
    </div>
  );
}

function ApprovalForm({ node, disabled, patch }: FormProps<"approval">) {
  return (
    <div className="space-y-3">
      <Field label="Message">
        <TextArea value={node.config.message ?? ""} rows={3} disabled={disabled} placeholder="What should be checked?" onChange={(m) => patch({ message: m || undefined })} />
      </Field>
      <Checkbox checked={node.config.showDiff} disabled={disabled} label="Show the lane diff" onChange={(showDiff) => patch({ showDiff })} />
    </div>
  );
}

function MergeForm({ node, disabled, patch }: FormProps<"merge">) {
  const graph = useEditorStore((s) => s.graph);
  const inputs = useMemo(() => (graph ? mergeInputLabels(graph, node.id) : []), [graph, node.id]);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="block text-xs font-medium text-zinc-400">Merge order</span>
        {inputs.length < 2 ? (
          <p className="text-[11px] text-zinc-500">Connect two or more parallel branches to this node.</p>
        ) : (
          <ol className="space-y-0.5 rounded-md bg-zinc-950 px-2 py-1.5 text-xs ring-1 ring-zinc-800">
            {inputs.map((label, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-3 text-right font-mono text-zinc-500">{i + 1}</span>
                <span className="truncate text-zinc-200">{label}</span>
                <span className="ml-auto shrink-0 text-[10px] text-zinc-500">{i === 0 ? "continues its lane" : "merged in"}</span>
              </li>
            ))}
          </ol>
        )}
        <span className="block text-[11px] leading-snug text-zinc-500">Inputs follow canvas order (left to right, then top to bottom); move nodes to reorder.</span>
      </div>
      <Field label="Strategy" hint="Other lanes are merged one at a time, in the order above.">
        <Select
          value={node.config.strategy}
          disabled={disabled}
          options={[
            { value: "merge", label: "Merge commit (--no-ff)" },
            { value: "squash", label: "Squash" },
          ]}
          onChange={(strategy) => patch({ strategy })}
        />
      </Field>
      <Field label="On conflict">
        <Select
          value={node.config.onConflict}
          disabled={disabled}
          options={[
            { value: "claude", label: "Let Claude resolve" },
            { value: "pause", label: "Pause for me" },
          ]}
          onChange={(onConflict) => patch({ onConflict })}
        />
      </Field>
    </div>
  );
}

const EVALUATOR_DEFAULTS: Record<ConditionEvaluator["kind"], ConditionEvaluator> = {
  exitCode: { kind: "exitCode", equals: 0 },
  regex: { kind: "regex", pattern: "", flags: "" },
  judge: { kind: "judge", question: "" },
};

/** Sets or removes (undefined) an optional key, so cleared fields do not linger as `undefined` in the file. */
function withOptional<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): T {
  const next = { ...obj };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function ConditionForm({ node, settings, disabled, patch }: FormProps<"condition">) {
  const ev = node.config.evaluator;
  return (
    <div className="space-y-3">
      <Field label="Evaluator">
        <Select
          value={ev.kind}
          disabled={disabled}
          options={[
            { value: "exitCode", label: "Exit code of predecessor" },
            { value: "regex", label: "Regex on predecessor output" },
            { value: "judge", label: "LLM judge" },
          ]}
          onChange={(kind) => patch({ evaluator: EVALUATOR_DEFAULTS[kind] })}
        />
      </Field>
      {ev.kind === "exitCode" && (
        <Field label="Equals">
          <OptionalNumber value={ev.equals} disabled={disabled} onChange={(equals) => patch({ evaluator: { ...ev, equals: equals ?? 0 } })} />
        </Field>
      )}
      {ev.kind === "regex" && (
        <div className="grid grid-cols-[1fr_72px] gap-2">
          <Field label="Pattern">
            <OptionalText value={ev.pattern} mono disabled={disabled} onChange={(pattern) => patch({ evaluator: { ...ev, pattern: pattern ?? "" } })} />
          </Field>
          <Field label="Flags">
            <OptionalText value={ev.flags} mono disabled={disabled} onChange={(flags) => patch({ evaluator: { ...ev, flags: flags ?? "" } })} />
          </Field>
        </div>
      )}
      {ev.kind === "judge" && (
        <>
          <Field label="Question" hint="Answered yes (true) / no (false) by headless Claude from the predecessor's output and the lane's diff stat. Its reason is passed to the next node.">
            <TextArea value={ev.question} rows={3} disabled={disabled} placeholder="Did the review report any blocking issue?" onChange={(question) => patch({ evaluator: { ...ev, question } })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Model">
              <OptionalText value={ev.model} placeholder={settings.defaults.model ? `Default (${settings.defaults.model})` : "Default"} disabled={disabled} onChange={(model) => patch({ evaluator: withOptional(ev, "model", model) })} />
            </Field>
            <Field label="Timeout (s)">
              <OptionalNumber value={ev.timeoutSec} min={1} placeholder="120" disabled={disabled} onChange={(t) => patch({ evaluator: withOptional(ev, "timeoutSec", t === undefined ? undefined : Math.max(1, Math.round(t))) })} />
            </Field>
          </div>
        </>
      )}
      {ev.kind === "exitCode" && <p className="text-[11px] text-zinc-500">true when the preceding shell node exited with this code; a timeout counts as false.</p>}
      {ev.kind === "regex" && <p className="text-[11px] text-zinc-500">true when the pattern matches the predecessor's output (its text, else the shell output tail).</p>}
    </div>
  );
}
