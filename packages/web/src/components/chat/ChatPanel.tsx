import type { ChatStatus } from "@promptgraph/shared";
import { MessageSquarePlusIcon, PanelRightCloseIcon, SendIcon, SquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatDateTime } from "../../lib/format";
import { useAppStore } from "../../store/app-store";
import { currentChatContext, sendChatMessage } from "../../store/chat-actions";
import { emptyView, formatCost, isBusy, useChatStore, type ChatSessionView } from "../../store/chat-store";
import { useEditorStore } from "../../store/editor-store";
import { useRunStore } from "../../store/run-store";
import { useUiStore } from "../../store/ui-store";
import { useDictation } from "../../lib/voice/use-dictation";
import { ConfirmDialog } from "../common/PromptDialog";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";
import { ChatItems, PermissionCard } from "./ChatItems";
import { DictationPreview, DictationStatus, MicButton } from "./Dictation";

const EMPTY_VIEW = emptyView();

/**
 * Chat with a background Claude Code session in the repository (DESIGN §20): session picker, messages with streamed
 * text and folded tool calls, the permission card, a status line and the composer with the context chip.
 */
export function ChatPanel() {
  const activeId = useChatStore((s) => s.activeSessionId);
  const view = useChatStore((s) => (activeId ? s.views[activeId] : undefined)) ?? EMPTY_VIEW;
  const error = useChatStore((s) => s.error);
  // Parallel tool calls may open several prompts: they are answered one at a time, oldest first.
  const pending = view.pendingPermissions[0];

  return (
    <section aria-label="Chat" className="flex h-full min-h-0 flex-col">
      <ChatHeader />
      {error && (
        <p role="alert" className="border-b bg-red-500/10 px-3 py-1.5 text-xs text-red-700">
          {error}
        </p>
      )}
      {/* Keyed by session: the scroll position, stick-to-bottom flag and draft belong to one chat. */}
      <MessageList key={`list-${activeId ?? "none"}`} view={view} hasSession={activeId !== null} />
      {activeId && pending && (
        <div className="border-t p-2">
          <PermissionCard
            key={pending.requestId}
            request={pending}
            queued={view.pendingPermissions.length - 1}
            onAnswer={(allow) => useChatStore.getState().answerPermission(activeId, pending.requestId, allow, allow ? undefined : "Denied by the user")}
          />
        </div>
      )}
      <StatusLine status={view.status} warning={view.warning} />
      <ReplyAnnouncer key={`announce-${activeId ?? "none"}`} view={view} />
      <Composer key={`composer-${activeId ?? "none"}`} sessionId={activeId} status={view.status} />
    </section>
  );
}

/**
 * Screen-reader announcement of each new final reply (a persistent polite live region; history loaded on open
 * is not announced).
 */
function ReplyAnnouncer({ view }: { view: ChatSessionView }) {
  const last = view.items.findLast((i) => i.kind === "assistant");
  const lastId = last?.id ?? null;
  const seen = useRef<string | null | undefined>(undefined);
  const [text, setText] = useState("");
  useEffect(() => {
    // The first value (and the one a loading view settles on) is history, not a new reply.
    if (seen.current === undefined || view.loading) {
      seen.current = lastId;
      return;
    }
    if (lastId === seen.current) return;
    seen.current = lastId;
    if (last?.kind === "assistant") setText(`Claude replied: ${last.text.length > 300 ? `${last.text.slice(0, 300)}…` : last.text}`);
  }, [lastId, last, view.loading]);
  return (
    <div aria-live="polite" className="sr-only" data-testid="chat-announcer">
      {text}
    </div>
  );
}

function ChatHeader() {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const active = sessions.find((s) => s.id === activeId);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start gap-1.5 px-2 font-medium">
            <span className="truncate">{active ? active.title || "New chat" : "Chat"}</span>
            <Icons.chevronDown className="shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 p-0">
          <div className="max-h-80 overflow-y-auto p-1">
            {sessions.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No chats yet.</p>}
            <DropdownMenuRadioGroup value={activeId ?? ""} onValueChange={(id) => void useChatStore.getState().selectSession(id)}>
              {sessions.map((s) => (
                <DropdownMenuRadioItem key={s.id} value={s.id} className="gap-2 py-1.5 pr-8 pl-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{s.title || "New chat"}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {formatDateTime(s.updatedAt)} · {formatCost(s.totalCostUsd)}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </div>
          <DropdownMenuSeparator className="mx-0 my-0" />
          <div className="p-1">
            <DropdownMenuItem className="justify-center text-xs font-medium" onSelect={() => void useChatStore.getState().newSession()}>
              <Icons.plus /> New chat
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {active && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums" title="Total cost of this chat">
          {formatCost(active.totalCostUsd)}
        </span>
      )}
      <IconAction label="New chat" onClick={() => void useChatStore.getState().newSession()}>
        <MessageSquarePlusIcon />
      </IconAction>
      {active && (
        <IconAction label="Delete chat" onClick={() => setConfirmDelete(true)}>
          <Icons.trash />
        </IconAction>
      )}
      <IconAction label="Close chat" onClick={() => useUiStore.getState().setChatOpen(false)}>
        <PanelRightCloseIcon />
      </IconAction>
      {confirmDelete && active && (
        <ConfirmDialog
          title="Delete chat"
          message={`Delete "${active.title || "this chat"}"? Its Claude Code process is stopped; the transcript stays in ~/.claude.`}
          confirmLabel="Delete"
          onConfirm={() => void useChatStore.getState().deleteSession(active.id)}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className="shrink-0 text-muted-foreground">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function MessageList({ view, hasSession }: { view: ChatSessionView; hasSession: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const streamedChars = Object.values(view.streaming).reduce((n, t) => n + t.length, 0);

  // Follow new content while the user is at the bottom; leave the scroll alone after they scrolled up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [view.items.length, streamedChars, view.pendingPermissions]);

  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {view.loading && view.items.length === 0 && <p className="text-xs text-muted-foreground">Loading chat…</p>}
      {view.loadError && <p role="alert" className="text-xs text-red-700">Could not load this chat: {view.loadError}</p>}
      {!view.loading && !view.loadError && view.items.length === 0 && view.streamingOrder.length === 0 && <EmptyState hasSession={hasSession} />}
      <ChatItems view={view} />
    </div>
  );
}

function EmptyState({ hasSession }: { hasSession: boolean }) {
  return (
    <div className="space-y-2 py-6 text-center text-xs text-muted-foreground">
      <p className="text-sm font-medium text-foreground">{hasSession ? "New chat" : "Design graphs with Claude"}</p>
      <p>Describe what you want to build and Claude drafts a graph, or ask it to change the graph on screen.</p>
      <ul className="space-y-1 text-left italic">
        <li>“I want to build a landing page with a hero, pricing and a signup form.”</li>
        <li>“Add a test step after this node.”</li>
        <li>“Simplify this graph.”</li>
      </ul>
    </div>
  );
}

const STATUS_TEXT: Partial<Record<ChatStatus, string>> = {
  starting: "Starting Claude Code…",
  thinking: "Claude is working…",
  waiting_permission: "Waiting for your permission",
  exited: "Session paused: it resumes on the next message.",
  error: "The Claude Code process failed.",
};

function StatusLine({ status, warning }: { status: ChatStatus; warning: string | null }) {
  const text = STATUS_TEXT[status];
  // Always mounted (possibly empty): screen readers announce changes of an existing live region only.
  return (
    <div role="status" className={cn("space-y-0.5 px-3 text-[11px]", (text || warning) && "border-t py-1")}>
      {text && (
        <p className={cn("flex items-center gap-1.5", status === "error" ? "text-red-700" : status === "waiting_permission" ? "text-amber-700" : "text-muted-foreground")}>
          {isBusy(status) && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
          {text}
        </p>
      )}
      {warning && (
        <p className="flex items-center gap-1.5 text-amber-700">
          <Icons.alert className="shrink-0" /> {warning}
        </p>
      )}
    </div>
  );
}

function Composer({ sessionId, status }: { sessionId: string | null; status: ChatStatus }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const connected = useAppStore((s) => s.connected);
  const busy = isBusy(status);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canSendText = (value: string) => value.trim().length > 0 && !busy && !sending && connected;

  useEffect(() => {
    inputRef.current?.focus();
  }, [sessionId]);

  const submit = async (value: string = text) => {
    if (!canSendText(value)) return;
    setSending(true);
    try {
      if (await sendChatMessage(value)) setText("");
    } finally {
      setSending(false);
    }
  };

  const dictation = useDictation({
    inputRef,
    value: text,
    setValue: setText,
    submit: (v) => {
      if (!canSendText(v)) return false;
      void submit(v);
      return true;
    },
    disabled: !connected,
  });
  const canSend = canSendText(text) && !dictation.active;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (dictation.onKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // The transcript is not in the value yet: Enter waits for it.
      if (!dictation.active) void submit();
    }
  };

  const listening = dictation.state === "recording" || dictation.state === "requesting_mic";
  const preview = dictation.insertion && dictation.partial ? dictation.insertion : null;

  return (
    <div className="shrink-0 space-y-1.5 border-t p-2">
      <ContextChip />
      <div className="flex items-end gap-1.5">
        {/* One grid cell for both: the in-flow preview grows the cell, so a long partial stretches the textarea too. */}
        <div className="relative grid min-w-0 flex-1">
          <Textarea
            ref={inputRef}
            aria-label="Message Claude"
            aria-describedby="chat-dictation-status"
            placeholder={
              // No placeholder under the preview: both would be drawn at the same spot.
              preview
                ? ""
                : listening
                  ? "Listening… speak now"
                  : dictation.state === "transcribing"
                    ? "Transcribing…"
                    : connected
                      ? "Ask Claude to design or change the graph…"
                      : "Reconnecting…"
            }
            value={text}
            rows={2}
            // The composer is frozen while dictating: the transcript goes where the cursor was, Esc restores it as it was.
            readOnly={dictation.active}
            className={cn("[grid-area:1/1] max-h-48 min-h-14 resize-none text-sm", preview && "text-transparent caret-transparent")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => void dictation.onKeyUp(e)}
          />
          {preview && <DictationPreview value={text} insertion={preview} partial={dictation.partial} textarea={inputRef.current} />}
        </div>
        <MicButton dictation={dictation} disabled={!connected} />
        {busy && sessionId ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" size="icon" aria-label="Stop" onClick={() => useChatStore.getState().interrupt(sessionId)}>
                <SquareIcon className="fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop Claude</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="primary" size="icon" aria-label="Send" disabled={!canSend} onClick={() => void submit()}>
                <SendIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send (Enter) · new line (Shift+Enter)</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div id="chat-dictation-status">
        <DictationStatus dictation={dictation} />
      </div>
    </div>
  );
}

/** What the next message tells Claude about the screen: the graph, the selection and the run. */
export function ContextChip() {
  // Subscriptions only re-render the chip; the context itself is read the same way sendChatMessage reads it.
  useEditorStore((s) => s.graph?.id);
  useEditorStore((s) => s.graph?.name);
  useEditorStore((s) => s.selectedNodeIds);
  useEditorStore((s) => s.selectedEdgeIds);
  useEditorStore((s) => s.activeRunId);
  useRunStore((s) => s.selectedRunId);
  useRunStore((s) => s.selectedNodeId);
  const ctx = currentChatContext();
  const parts: string[] = [];
  const nodes = ctx.selectedNodeIds.length;
  const edges = ctx.selectedEdgeIds.length;
  if (nodes === 1) parts.push(`node ${ctx.selectedNodeIds[0]}`);
  else if (nodes > 1) parts.push(`${nodes} nodes`);
  if (edges) parts.push(edges === 1 ? "1 edge" : `${edges} edges`);
  if (ctx.runId) parts.push("run");
  if (ctx.graphId && ctx.readOnly) parts.push("read-only");
  const title = ctx.graphId
    ? `Sent with each message: graph ${ctx.graphId}${nodes ? `, selected nodes ${ctx.selectedNodeIds.join(", ")}` : ""}${edges ? `, selected edges ${ctx.selectedEdgeIds.join(", ")}` : ""}${ctx.runId ? `, run ${ctx.runId}` : ""}`
    : "No graph is open";
  return (
    <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" title={title} data-testid="chat-context">
      <Icons.layers className="shrink-0" />
      <span className="truncate">
        {ctx.graphId ? (ctx.graphName ?? ctx.graphId) : "No graph open"}
        {parts.length > 0 && <span className="text-muted-foreground/80"> · {parts.join(" · ")}</span>}
      </span>
    </div>
  );
}
