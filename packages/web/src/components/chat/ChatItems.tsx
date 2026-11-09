import { parseAskUserQuestion, shortToolName, type ChatItem, type ChatPermissionRequestItem } from "@promptgraph/shared";
import {
  BanIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  NetworkIcon,
  PencilIcon,
  PlayIcon,
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { buildChatBlocks, groupTitle, stepLabel, stepStatus, toolCategory, type ChatBlock, type StepStatus, type ToolCategory, type ToolStep } from "../../lib/chat-blocks";
import { Markdown } from "../../lib/markdown";
import type { ChatSessionView } from "../../store/chat-store";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";

/**
 * Renders a session's items (DESIGN §21.6): messages, consecutive tool calls folded into one activity group (each
 * call with its result and permission answer), answered questions, the streamed text and, while Claude works
 * without streaming text, a "Thinking" line.
 */
export function ChatItems({ view, thinking = false }: { view: ChatSessionView; thinking?: boolean }) {
  const blocks = useMemo(() => buildChatBlocks(view.items), [view.items]);
  const streaming = view.streamingOrder.length > 0;
  return (
    <ol className="flex flex-col gap-3" aria-label="Chat messages">
      {blocks.map((block) => (
        <li key={block.id}>
          <BlockView block={block} />
        </li>
      ))}
      {view.streamingOrder.map((messageId) => (
        <li key={`stream-${messageId}`}>
          {(view.streamingStart[messageId] ?? 0) > 0 ? (
            // The beginning of this message was streamed before the view existed: wait for the final text.
            <p className="text-xs text-muted-foreground italic" data-kind="receiving">
              Receiving reply…
            </p>
          ) : (
            <AssistantText text={view.streaming[messageId] ?? ""} streaming />
          )}
        </li>
      ))}
      {thinking && !streaming && !runningGroupAtEnd(blocks) && (
        <li>
          <ThinkingLine />
        </li>
      )}
    </ol>
  );
}

/** The last block is a group with a call still running: its own spinner already says Claude is working. */
function runningGroupAtEnd(blocks: readonly ChatBlock[]): boolean {
  const last = blocks.at(-1);
  return last?.type === "tools" && last.steps.some((s) => stepStatus(s) === "running");
}

function ThinkingLine() {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" data-kind="thinking">
      <span className="flex gap-0.5" aria-hidden="true">
        {[0, 150, 300].map((delay) => (
          <span key={delay} className="size-1 animate-bounce rounded-full bg-current" style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      Thinking…
    </p>
  );
}

function BlockView({ block }: { block: ChatBlock }) {
  switch (block.type) {
    case "tools":
      return <ToolGroup steps={block.steps} />;
    case "question":
      return <QuestionBlock step={block.step} />;
    case "item":
      return <ItemView item={block.item} />;
  }
}

function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap text-foreground" data-kind="user">
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return <AssistantText text={item.text} />;
    case "tool_result":
      // A result whose call is not shown (e.g. trimmed from the log).
      return <Pre label={item.isError ? "Error" : "Result"} text={item.text || "(empty)"} error={item.isError} />;
    case "permission_resolved": {
      // An answer whose call is not shown (e.g. a prompt without tool_use id).
      const how = item.by === "user" ? (item.allowed ? "Allowed" : "Denied") : item.by === "interrupt" ? "Cancelled (stopped)" : "Cancelled (session ended)";
      return (
        <p className={cn("flex items-center gap-1.5 text-xs", item.allowed ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
          <ShieldAlertIcon className="size-3.5" /> {how}
        </p>
      );
    }
    case "result":
      if (!item.isError) return null;
      return (
        <p className="text-xs text-muted-foreground" data-kind="result">
          {item.subtype === "error_during_execution" ? "Stopped." : `Turn ended: ${item.subtype.replace(/_/g, " ")}.`}
        </p>
      );
    case "error":
      return (
        <p role="alert" className="flex items-start gap-1.5 rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-400">
          <Icons.alert className="mt-0.5 shrink-0" /> {item.message}
        </p>
      );
    case "notice":
      return <p className="text-xs text-muted-foreground italic">{item.text}</p>;
    case "tool_use":
    case "permission_request":
      return null;
  }
}

function AssistantText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="text-foreground" data-kind="assistant" aria-busy={streaming || undefined}>
      <Markdown text={text} />
      {streaming && <span aria-hidden="true" className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/60 align-middle" />}
    </div>
  );
}

// --- Tool activity ---------------------------------------------------------

const CATEGORY_ICONS: Record<ToolCategory, LucideIcon> = {
  read: FileTextIcon,
  search: SearchIcon,
  edit: PencilIcon,
  shell: TerminalIcon,
  web: GlobeIcon,
  skill: SparklesIcon,
  agent: BotIcon,
  todo: ListTodoIcon,
  graph_read: NetworkIcon,
  graph_write: NetworkIcon,
  run: PlayIcon,
  other: WrenchIcon,
};

function StatusMark({ status, className }: { status: StepStatus; className?: string }) {
  switch (status) {
    case "running":
      return <LoaderCircleIcon className={cn("size-3.5 shrink-0 animate-spin text-blue-500", className)} aria-label="running" />;
    case "done":
      return <CheckIcon className={cn("size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400", className)} aria-label="done" />;
    case "error":
      return <CircleAlertIcon className={cn("size-3.5 shrink-0 text-red-600", className)} aria-label="error" />;
    case "denied":
      return <BanIcon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} aria-label="denied" />;
  }
}

/**
 * One collapsible block for consecutive tool calls, as in Claude's apps: the header says what is running (or, once
 * done, what the block did) and how many steps it took; opening it lists every call, each expandable to its input
 * and result.
 */
function ToolGroup({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const statuses = steps.map(stepStatus);
  const running = statuses.includes("running");
  const failed = statuses.filter((s) => s === "error").length;
  const denied = statuses.filter((s) => s === "denied").length;
  const status: StepStatus = running ? "running" : failed ? "error" : denied === steps.length ? "denied" : "done";
  const title = groupTitle(steps);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/tools" data-kind="tool_group">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <StatusMark status={status} />
          <span className={cn("min-w-0 flex-1 truncate", running && "animate-pulse")}>
            {title}
            {running ? "…" : ""}
          </span>
          {(failed > 0 || denied > 0) && (
            <span className="shrink-0 text-[11px]">
              {[failed && `${failed} failed`, denied && `${denied} denied`].filter(Boolean).join(" · ")}
            </span>
          )}
          <span className="shrink-0 text-[11px] tabular-nums">{steps.length === 1 ? "1 step" : `${steps.length} steps`}</span>
          <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-1 ml-[0.4rem] space-y-0.5 border-l pl-3">
          {steps.map((step) => (
            <li key={step.use.id}>
              <StepRow step={step} />
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StepRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const Icon = CATEGORY_ICONS[toolCategory(step.use.name)];
  const status = stepStatus(step);
  const label = stepLabel(step.use);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-kind="tool_use">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title={step.use.name}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {step.permission && (
            <span className="shrink-0 text-[10px]">{step.permission.allowed ? "allowed" : step.permission.by === "user" ? "denied" : "cancelled"}</span>
          )}
          <StatusMark status={status} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5 py-1 pl-5">
        <Pre label={shortToolName(step.use.name)} text={stringify(step.use.input)} />
        {step.result && <Pre label={step.result.isError ? "Error" : "Result"} text={step.result.text || "(empty)"} error={step.result.isError} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Pre({ label, text, error = false }: { label: string; text: string; error?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</div>
      <pre className={cn("max-h-48 overflow-auto rounded bg-muted p-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap", error && "text-red-700 dark:text-red-400")}>
        {text}
      </pre>
    </div>
  );
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// --- Questions -------------------------------------------------------------

/** An AskUserQuestion call in the conversation: waiting, skipped, or each question with the user's answer. */
function QuestionBlock({ step }: { step: ToolStep }) {
  const questions = parseAskUserQuestion(step.use.input) ?? [];
  const answers = step.result?.answers;
  const skipped = step.permission ? !step.permission.allowed : false;
  const waiting = !step.result && !step.permission;
  return (
    <div className="rounded-lg border bg-card/50 px-3 py-2 text-xs" data-kind="question">
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-muted-foreground">
        <MessageCircleQuestionIcon className="size-3.5 shrink-0" />
        {waiting ? "Claude is asking you…" : skipped ? "Questions skipped" : questions.length === 1 ? "Claude asked" : `Claude asked ${questions.length} questions`}
      </p>
      <dl className="space-y-1.5">
        {questions.map((q) => (
          <div key={q.question}>
            <dt className="text-muted-foreground">{q.question}</dt>
            <dd className={cn("font-medium text-foreground", !answers?.[q.question] && "text-muted-foreground italic")}>
              {answers?.[q.question] ?? (waiting ? "Waiting for your answer" : skipped ? "Skipped" : "—")}
            </dd>
          </div>
        ))}
      </dl>
      {!answers && step.result && !skipped && <p className="mt-1.5 text-muted-foreground">{step.result.text}</p>}
    </div>
  );
}

// --- Permission card -------------------------------------------------------

/**
 * Allow / Deny card for the prompt Claude is waiting on. Focus moves to Allow when it appears, so keyboard and
 * screen-reader users learn that Claude is blocked on them. `queued`: further prompts waiting after this one.
 */
export function PermissionCard({
  request,
  onAnswer,
  queued = 0,
}: {
  request: ChatPermissionRequestItem;
  onAnswer: (allow: boolean) => void;
  queued?: number;
}) {
  const tool = request.displayName ?? shortToolName(request.toolName);
  const allowRef = useRef<HTMLButtonElement>(null);
  const descId = useId();
  useEffect(() => {
    allowRef.current?.focus();
  }, [request.requestId]);
  return (
    <div
      role="alertdialog"
      aria-label={`Permission request: ${tool}`}
      aria-describedby={descId}
      className="space-y-2 rounded-lg bg-amber-500/10 p-3 ring-1 ring-amber-500/40"
    >
      <p id={descId} className="flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-300">
        <ShieldAlertIcon className="size-4 shrink-0" /> Claude wants to use {tool}
        {queued > 0 && <span className="ml-auto text-xs font-normal text-muted-foreground">+{queued} more waiting</span>}
      </p>
      {request.description && <p className="text-xs text-foreground/80">{request.description}</p>}
      {request.blockedPath && (
        <p className="text-xs text-foreground/80">
          Path: <code className="font-mono">{request.blockedPath}</code>
        </p>
      )}
      <pre className="max-h-40 overflow-auto rounded bg-card p-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap">{stringify(request.input)}</pre>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={() => onAnswer(false)}>
          Deny
        </Button>
        <Button ref={allowRef} size="sm" variant="primary" onClick={() => onAnswer(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}

