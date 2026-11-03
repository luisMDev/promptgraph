import type { ClaudeCheckResponse, ClaudeSetupResponse, McpSkillInfo, McpToolGroup } from '@promptgraph/shared';
import { Fragment, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { api, errorMessage } from '../../api/rest';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icons } from '../common/icons';
import { Button, Modal } from '../common/ui';

/** Steps in order. `id` is stable; `label` is what the user reads. */
const STEPS = [
  { id: 'connect', label: 'Connect' },
  { id: 'check', label: 'Check' },
  { id: 'skills', label: 'Skills' },
  { id: 'tools', label: 'Tools' },
  { id: 'try', label: 'Try it' },
] as const;

type Plan = 'plugin' | 'mcp';
type CheckState =
  { status: 'idle' } | { status: 'running' } | { status: 'done'; result: ClaudeCheckResponse } | { status: 'error'; message: string };

/** Header entry point: a button that opens the Claude Code setup wizard. */
export function ClaudeSetupButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Connect Claude Code"
            onClick={() => setOpen(true)}
            className="gap-1.5 text-muted-foreground"
          >
            <Icons.plug />
            Claude Code
          </Button>
        </TooltipTrigger>
        <TooltipContent>Connect Claude Code to promptgraph</TooltipContent>
      </Tooltip>
      {open && <ClaudeSetupWizard onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Setup wizard (DESIGN §19.5). One clear action per step: pick how to connect, run the check (it also runs
 * when you reach the step), read the skills, scan the tools, copy a prompt. Commands come from the running
 * server, so they name this checkout and this CLI.
 */
export function ClaudeSetupWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [plan, setPlan] = useState<Plan>('plugin');
  const [setup, setSetup] = useState<ClaudeSetupResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  const checkSeq = useRef(0);

  const load = () => {
    setLoadError(null);
    api.claudeSetup().then(setSetup, (err: unknown) => setLoadError(errorMessage(err)));
  };
  useEffect(load, []);

  /** Runs the check; a newer run ignores the result of an older one. */
  const runCheck = () => {
    const seq = ++checkSeq.current;
    setCheck({ status: 'running' });
    api.checkClaudeSetup().then(
      (result) => seq === checkSeq.current && setCheck({ status: 'done', result }),
      (err: unknown) => seq === checkSeq.current && setCheck({ status: 'error', message: errorMessage(err) }),
    );
  };

  // Entering the check step runs it once, so the user does not have to press anything.
  useEffect(() => {
    if (STEPS[step]?.id === 'check' && check.status === 'idle') runCheck();
    // runCheck only reads refs and setters, so it does not need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, check.status]);

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step]!.id;

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Icons.sparkles className="text-muted-foreground" />
          Connect Claude Code
        </span>
      }
      wide
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            Step {step + 1} of {STEPS.length}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
              Back
            </Button>
            {isLast ? (
              <Button onClick={onClose}>Finish</Button>
            ) : (
              <Button onClick={() => setStep((s) => s + 1)}>
                {current === 'check' && check.status === 'done' && check.result.mcpRegistered ? 'Continue' : 'Next'}
                <Icons.arrowRight />
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="mx-auto max-w-4xl">
        <Stepper step={step} onSelect={setStep} />

        <div className="mt-6">
          {loadError ? (
            <ErrorBox message={`Could not load the setup information: ${loadError}`} onRetry={load} />
          ) : !setup ? (
            <LoadingSkeleton />
          ) : current === 'connect' ? (
            <ConnectStep setup={setup} plan={plan} onPlan={setPlan} />
          ) : current === 'check' ? (
            <CheckStep plan={plan} check={check} onRecheck={runCheck} onNext={() => setStep((s) => s + 1)} />
          ) : current === 'skills' ? (
            <SkillsStep skills={setup.skills} />
          ) : current === 'tools' ? (
            <ToolsStep groups={setup.toolGroups} />
          ) : (
            <TryStep
              skills={setup.skills}
              registered={check.status === 'done' ? check.result.mcpRegistered : null}
              onRecheck={() => setStep(1)}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function Stepper({ step, onSelect }: { step: number; onSelect: (i: number) => void }) {
  return (
    <nav aria-label="Setup progress">
      <ol className="flex items-center">
        {STEPS.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <Fragment key={s.id}>
              <li>
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  aria-current={active ? 'step' : undefined}
                  className="group flex items-center gap-2 rounded-md px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors',
                      done && 'border-foreground bg-foreground text-background',
                      active && 'border-foreground text-foreground ring-4 ring-foreground/10',
                      !done && !active && 'border-border text-muted-foreground group-hover:text-foreground',
                    )}
                  >
                    {done ? <Icons.check className="size-3.5" /> : i + 1}
                  </span>
                  <span className={cn('text-sm', active ? 'font-semibold' : 'text-muted-foreground group-hover:text-foreground')}>
                    {s.label}
                  </span>
                </button>
              </li>
              {i < STEPS.length - 1 && (
                <li aria-hidden className={cn('mx-2 h-px flex-1 transition-colors', i < step ? 'bg-foreground' : 'bg-border')} />
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// 1. Connect
// ---------------------------------------------------------------------------

function ConnectStep({ setup, plan, onPlan }: { setup: ClaudeSetupResponse; plan: Plan; onPlan: (p: Plan) => void }) {
  const pluginCommands = [
    ...(setup.plugin.available && setup.plugin.addMarketplaceCommand ? [setup.plugin.addMarketplaceCommand] : []),
    setup.plugin.installCommand,
  ];
  const pluginUnavailable = !setup.plugin.available;
  const selectedPlan: Plan = pluginUnavailable && plan === 'plugin' ? 'mcp' : plan;

  return (
    <div className="space-y-6">
      <div role="radiogroup" aria-label="How to connect" className="grid gap-3 md:grid-cols-2">
        <PlanCard
          selected={selectedPlan === 'plugin'}
          disabled={pluginUnavailable}
          onSelect={() => onPlan('plugin')}
          title="Plugin"
          badge={pluginUnavailable ? 'Not bundled here' : 'Recommended'}
          description="Adds the MCP server and three skills. Claude knows when to use them."
          points={['Skills: design, run and review', 'Tools and guidance in one install']}
        />
        <PlanCard
          selected={selectedPlan === 'mcp'}
          onSelect={() => onPlan('mcp')}
          title="MCP server only"
          description="Only the tools. Claude can still read and change graphs, but has no skills."
          points={['Same tools as the plugin', 'No skills; you describe the work yourself']}
        />
      </div>

      {selectedPlan === 'plugin' ? (
        <CommandSection heading="Run these inside Claude Code, one after the other" commands={pluginCommands} where="Claude Code" />
      ) : (
        <CommandSection heading="Run this in a terminal" commands={[setup.mcpAddCommand]} where="Terminal" />
      )}

      <details className="group rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        <summary className="cursor-pointer list-none font-medium">
          <span className="inline-flex items-center gap-2">
            <Icons.chevronDown className="size-4 transition-transform group-open:rotate-180" />
            The plugin cannot find promptgraph?
          </span>
        </summary>
        <div className="mt-3 space-y-2 text-muted-foreground">
          <p className="text-xs">
            The plugin starts <code className="font-mono">promptgraph mcp</code> from your PATH. Point it at this build instead:
          </p>
          <CopyButtonRow text={`export PROMPTGRAPH_BIN=${setup.binPath}`} />
        </div>
      </details>
    </div>
  );
}

function PlanCard({
  selected,
  disabled = false,
  onSelect,
  title,
  badge,
  description,
  points,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  description: string;
  points: string[];
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        selected ? 'border-foreground bg-card shadow-soft' : 'bg-card/50 hover:border-foreground/40',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <span className="flex items-center gap-2">
          {badge && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{badge}</span>}
          <span
            aria-hidden
            className={cn(
              'flex size-4 items-center justify-center rounded-full border',
              selected ? 'border-foreground bg-foreground text-background' : 'border-border',
            )}
          >
            {selected && <Icons.check className="size-2.5" />}
          </span>
        </span>
      </span>
      <span className="text-sm text-muted-foreground">{description}</span>
      <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
        {points.map((p) => (
          <li key={p} className="flex items-center gap-1.5">
            <span className="size-1 rounded-full bg-foreground/60" />
            {p}
          </li>
        ))}
      </ul>
    </button>
  );
}

function CommandSection({ heading, commands, where }: { heading: string; commands: string[]; where: string }) {
  return (
    <section className="space-y-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{heading}</h3>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{where}</span>
      </header>
      <ol className="space-y-2">
        {commands.map((c, i) => (
          <li key={c} className="flex items-start gap-3">
            <span className="mt-2 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <CopyButtonRow text={c} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A monospace command in a code box, with a copy button that confirms in place. */
function CopyButtonRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={text}>
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

/** Copies `text`; the label turns into a check mark for a moment. Falls back to a hint without a clipboard. */
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied && !failed) return;
    const t = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1600);
    return () => clearTimeout(t);
  }, [copied, failed]);

  const copy = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      setFailed(true);
      return;
    }
    clipboard.writeText(text).then(
      () => setCopied(true),
      () => setFailed(true),
    );
  };

  return (
    <Button variant="secondary" size="sm" onClick={copy} aria-label={`Copy: ${text}`} className="shrink-0 gap-1.5">
      {copied ? <Icons.check className="size-3.5" /> : <Icons.copy className="size-3.5" />}
      {failed ? 'Select & copy' : copied ? 'Copied' : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// 2. Check
// ---------------------------------------------------------------------------

function CheckStep({ plan, check, onRecheck, onNext }: { plan: Plan; check: CheckState; onRecheck: () => void; onNext: () => void }) {
  const result = check.status === 'done' ? check.result : null;
  const running = check.status === 'running' || check.status === 'idle';
  const registered = result?.mcpRegistered === true;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-base font-semibold">
            {running ? 'Checking your setup…' : registered ? 'Claude Code can see promptgraph' : 'Not connected yet'}
          </h3>
          <p className="text-sm text-muted-foreground">
            Runs <code className="font-mono text-xs">claude mcp list</code> on this machine. Nothing is installed by this check.
          </p>
        </div>
        <Button variant="secondary" onClick={onRecheck} disabled={running} className="shrink-0 gap-1.5">
          <Icons.refresh className={cn('size-3.5', running && 'animate-spin')} />
          Re-check
        </Button>
      </div>

      <ul className="divide-y rounded-xl border bg-card">
        <CheckRow
          title="Claude Code CLI"
          state={running ? 'pending' : result?.claudeFound ? 'ok' : 'fail'}
          okText="Found on your PATH"
          failText="The claude command was not found. Install Claude Code, then re-check."
        />
        <CheckRow
          title="promptgraph MCP server"
          state={running ? 'pending' : registered ? 'ok' : 'fail'}
          okText="Listed by Claude Code"
          failText={
            plan === 'plugin'
              ? 'Not listed yet. Run the plugin commands in Claude Code, then restart it.'
              : 'Not listed yet. Run the terminal command, then restart Claude Code.'
          }
        />
      </ul>

      {check.status === 'error' && (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700">
          The check failed: {check.message}
        </p>
      )}

      {!running && !registered && result && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800">
          Restart Claude Code after installing so it loads the server, then press Re-check. You can still continue and try the rest.
        </p>
      )}

      {registered && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-600/30 bg-emerald-500/10 px-4 py-3">
          <span className="text-sm text-emerald-800">Nothing else to set up. Next: the skills Claude gets.</span>
          <Button onClick={onNext}>
            Continue <Icons.arrowRight />
          </Button>
        </div>
      )}

      {result && (
        <details className="rounded-lg border bg-muted/30 px-4 py-2 text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">Command output</summary>
          <pre className="mt-2 max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{result.output || '(no output)'}</pre>
        </details>
      )}
    </div>
  );
}

function CheckRow({
  title,
  state,
  okText,
  failText,
}: {
  title: string;
  state: 'pending' | 'ok' | 'fail';
  okText: string;
  failText: string;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full',
          state === 'ok' && 'bg-emerald-600 text-white',
          state === 'fail' && 'bg-amber-500 text-white',
          state === 'pending' && 'bg-muted text-muted-foreground',
        )}
        aria-hidden
      >
        {state === 'ok' ? (
          <Icons.check className="size-3.5" />
        ) : state === 'fail' ? (
          <Icons.alert className="size-3.5" />
        ) : (
          <Icons.refresh className="size-3.5 animate-spin" />
        )}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{state === 'pending' ? 'Checking…' : state === 'ok' ? okText : failText}</p>
      </div>
      <span className="sr-only">{state === 'ok' ? 'passed' : state === 'fail' ? 'failed' : 'in progress'}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 3. Skills
// ---------------------------------------------------------------------------

const SKILL_ICON: Record<string, ComponentType<{ className?: string }>> = {
  'design-graph': Icons.sparkles,
  'run-graph': Icons.play,
  'review-run': Icons.search,
};

function SkillsStep({ skills }: { skills: readonly McpSkillInfo[] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Skills are short playbooks Claude follows. It picks one when your request matches; you can also name it, like “use design-graph”.
      </p>
      <div className="grid gap-3 lg:grid-cols-3">
        {skills.map((skill) => {
          const Icon = SKILL_ICON[skill.name] ?? Icons.sparkles;
          return (
            <article key={skill.name} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{skill.title}</h3>
                  <code className="font-mono text-[11px] text-muted-foreground">{skill.name}</code>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">{skill.summary}</p>
              <div className="mt-auto space-y-1.5 pt-1">
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Try asking</p>
                {skill.examples.map((ex) => (
                  <div key={ex} className="flex items-start gap-2 rounded-md bg-muted/50 py-1.5 pr-1.5 pl-2.5">
                    <p className="min-w-0 flex-1 text-xs leading-relaxed">“{ex}”</p>
                    <CopyButton text={ex} label="" />
                  </div>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Tools
// ---------------------------------------------------------------------------

function ToolsStep({ groups }: { groups: readonly McpToolGroup[] }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          tools: g.tools.filter((t) => !q || t.name.includes(q) || t.summary.toLowerCase().includes(q)),
        }))
        .filter((g) => g.tools.length > 0),
    [groups, q],
  );
  const total = groups.reduce((n, g) => n + g.tools.length, 0);
  const shown = visible.reduce((n, g) => n + g.tools.length, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          These are the tools Claude can call. Tools marked <Badge tone="warn">asks first</Badge> stop for your confirmation. Approvals are
          never among them.
        </p>
        <label className="relative flex items-center sm:w-64">
          <Icons.search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${total} tools`}
            aria-label="Filter tools"
            className="h-8 w-full rounded-md border bg-card pr-2 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No tool matches “{query}”.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((group) => (
            <section key={group.title} className="rounded-xl border bg-card">
              <header className="flex items-center justify-between border-b px-4 py-2.5">
                <h3 className="text-sm font-semibold">{group.title}</h3>
                <span className="text-xs text-muted-foreground">{group.tools.length}</span>
              </header>
              <ul className="divide-y">
                {group.tools.map((tool) => (
                  <li key={tool.name} className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs font-medium">{tool.name}</code>
                      {tool.confirmFirst && <Badge tone="warn">asks first</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">{tool.summary}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {q && (
        <p className="text-xs text-muted-foreground">
          Showing {shown} of {total}.
        </p>
      )}
    </div>
  );
}

function Badge({ tone, children }: { tone: 'warn' | 'neutral'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        tone === 'warn' ? 'bg-amber-500/15 text-amber-800' : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 5. Try it
// ---------------------------------------------------------------------------

const PROMPTS: Array<{ label: string; text: string; icon: ComponentType<{ className?: string }> }> = [
  {
    label: 'Design a graph',
    text: 'Design a promptgraph graph that implements TODO.md with a test-fix loop, then save it as implement-todo.',
    icon: Icons.sparkles,
  },
  { label: 'Run it', text: 'Run the implement-todo graph and tell me when a step needs me.', icon: Icons.play },
  { label: 'Check status', text: 'Check promptgraph: is a server running, and what does the last run look like?', icon: Icons.layers },
  {
    label: 'Review a run',
    text: 'Summarise the last promptgraph run: what changed, what failed, and what I should fix in the graph.',
    icon: Icons.search,
  },
];

function TryStep({
  skills,
  registered,
  onRecheck,
}: {
  skills: readonly McpSkillInfo[];
  /** Result of the check: null until it ran. */
  registered: boolean | null;
  onRecheck: () => void;
}) {
  const ready = registered === true;
  return (
    <div className="space-y-5">
      {ready ? (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-600/30 bg-emerald-500/10 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
            <Icons.check className="size-4" />
          </span>
          <div>
            <h3 className="font-semibold">You are set up</h3>
            <p className="text-sm text-muted-foreground">
              Paste a prompt into Claude Code, in the repository you work on. It uses the {skills.map((s) => s.name).join(', ')} skills as
              needed.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-white">
              <Icons.alert className="size-4" />
            </span>
            <div>
              <h3 className="font-semibold">Not connected yet</h3>
              <p className="text-sm text-muted-foreground">
                {registered === false
                  ? 'Claude Code does not list promptgraph yet. The prompts below work once it does.'
                  : 'The connection has not been checked yet. The prompts below work once Claude Code lists promptgraph.'}
              </p>
            </div>
          </div>
          <Button variant="secondary" onClick={onRecheck} className="shrink-0">
            Back to the check
          </Button>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {PROMPTS.map((p) => (
          <article key={p.label} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <p.icon className="size-4 text-muted-foreground" />
                {p.label}
              </span>
              <CopyButton text={p.text} label="Copy prompt" />
            </div>
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed">{p.text}</p>
          </article>
        ))}
      </div>

      <p className="rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
        To watch a run, ask Claude to call <code className="font-mono">open_ui</code>, or open this canvas from the terminal where
        promptgraph runs. Approving a step is always done here, never by Claude.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared states
// ---------------------------------------------------------------------------

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-700">
      <span>{message}</span>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading setup">
      <div className="h-12 animate-pulse rounded-lg bg-muted" />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}
