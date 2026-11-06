import { shortToolName, type ChatItem, type ChatItemOf, type ChatPermissionRequestItem } from "@promptgraph/shared";
import { ChevronRightIcon, ShieldAlertIcon, WrenchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Markdown } from "../../lib/markdown";
import type { ChatSessionView } from "../../store/chat-store";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";

/** Renders a session's items in order; tool results are folded into their tool_use row. */
export function ChatItems({ view }: { view: ChatSessionView }) {
  const results = new Map<string, ChatItemOf<"tool_result">>();
  const requests = new Map<string, ChatPermissionRequestItem>();
  const toolUseIds = new Set<string>();
  for (const item of view.items) {
    if (item.kind === "tool_result") results.set(item.toolUseId, item);
    else if (item.kind === "permission_request") requests.set(item.requestId, item);
    else if (item.kind === "tool_use") toolUseIds.add(item.toolUseId);
  }
  return (
    <ol className="flex flex-col gap-3" aria-label="Chat messages">
      {view.items.map((item) => {
        // A result whose tool_use is shown renders inside that row.
        if (item.kind === "tool_result" && toolUseIds.has(item.toolUseId)) return null;
        // The pending prompt is shown as the permission card instead.
        if (item.kind === "permission_request") return null;
        return (
          <li key={item.id}>
            <ItemView item={item} results={results} requests={requests} />
          </li>
        );
      })}
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
    </ol>
  );
}

function ItemView({
  item,
  results,
  requests,
}: {
  item: ChatItem;
  results: ReadonlyMap<string, ChatItemOf<"tool_result">>;
  requests: ReadonlyMap<string, ChatPermissionRequestItem>;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-8 rounded-lg bg-primary/8 px-3 py-2 text-sm whitespace-pre-wrap text-foreground ring-1 ring-primary/15" data-kind="user">
          {item.text}
        </div>
      );
    case "assistant":
      return <AssistantText text={item.text} />;
    case "tool_use":
      return <ToolRow item={item} result={results.get(item.toolUseId)} />;
    case "tool_result":
      return <ToolResultBody result={item} />;
    case "permission_resolved": {
      const req = requests.get(item.requestId);
      const tool = req ? (req.displayName ?? shortToolName(req.toolName)) : "tool";
      const how = item.by === "user" ? (item.allowed ? "Allowed" : "Denied") : item.by === "interrupt" ? "Cancelled (stopped)" : "Cancelled (session ended)";
      return (
        <p className={cn("flex items-center gap-1.5 text-xs", item.allowed ? "text-emerald-700" : "text-muted-foreground")}>
          <ShieldAlertIcon className="size-3.5" /> {how}: {tool}
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
        <p role="alert" className="flex items-start gap-1.5 rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-700">
          <Icons.alert className="mt-0.5 shrink-0" /> {item.message}
        </p>
      );
    case "notice":
      return <p className="text-xs text-muted-foreground italic">{item.text}</p>;
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

function ToolRow({ item, result }: { item: ChatItemOf<"tool_use">; result: ChatItemOf<"tool_result"> | undefined }) {
  const [open, setOpen] = useState(false);
  const status = !result ? "running" : result.isError ? "error" : "done";
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md ring-1 ring-border" data-kind="tool_use">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
          title={item.name}
        >
          <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          <WrenchIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono">{item.summary || shortToolName(item.name)}</span>
          {status === "running" && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" aria-label="running" />}
          {status === "error" && <span className="shrink-0 text-red-600">error</span>}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5 border-t px-2 py-1.5">
        <Pre label="Input" text={stringify(item.input)} />
        {result && <ToolResultBody result={result} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolResultBody({ result }: { result: ChatItemOf<"tool_result"> }) {
  return <Pre label={result.isError ? "Error" : "Result"} text={result.text || "(empty)"} error={result.isError} />;
}

function Pre({ label, text, error = false }: { label: string; text: string; error?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</div>
      <pre className={cn("max-h-48 overflow-auto rounded bg-muted p-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap", error && "text-red-700")}>{text}</pre>
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
