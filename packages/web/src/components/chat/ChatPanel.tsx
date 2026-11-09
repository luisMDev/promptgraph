import { ASK_USER_QUESTION_TOOL, parseAskUserQuestion, type ChatPermissionRequestItem, type ChatStatus } from "@promptgraph/shared";
import { MinusIcon, MoreHorizontalIcon, PanelRightCloseIcon, PanelRightOpenIcon, SendIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatDateTime } from "../../lib/format";
import { currentChatContext, sendChatMessage } from "../../store/chat-actions";
import { emptyView, formatCost, getChatStore, isBusy, useRepoChat, type ChatSessionView, type ChatStore } from "../../store/chat-store";
import { useDaemonStore } from "../../store/daemon-store";
import { useRepoCache } from "../../store/repo-cache";
import { useEditor, useRun, useView } from "../../store/view/context";
import { useDictation } from "../../lib/voice/use-dictation";
import { isDictationActive, useVoiceStore } from "../../store/voice-store";
import { ConfirmDialog } from "../common/PromptDialog";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";
import { ChatItems, PermissionCard } from "./ChatItems";
import { QuestionCard } from "./ChatQuestionCard";
import { DictationPreview, DictationStatus, MicButton } from "./Dictation";

const EMPTY_VIEW = emptyView();

/** The chat state of the view's repository (each repository has its own sessions, §21). */
function useChat<T>(selector: (s: ChatStore) => T): T {
  return useRepoChat(useView().repoId, selector);
}

/** What a chat window does besides the conversation: minimise it, close it (out of the bar), grow or shrink it. */
export interface ChatWindowActions {
  onMinimize(): void;
  onClose(): void;
  expanded: boolean;
  onToggleExpanded(): void;
}

/**
 * A chat window (DESIGN §21.11): one Claude Code session of the repository, opened from the bottom bar. Floating above
 * the tab's panel at the bottom right, or, expanded (`docked`), a full-height side panel to the right of the tab's
 * panel, resizable from its left edge. Header with the title, cost and the window actions; then the conversation.
 */
export function ChatWindow({ sessionId, actions, docked = false }: { sessionId: string; actions: ChatWindowActions; docked?: boolean }) {
  const [width, setWidth] = useState(readDockWidth);
  return (
    <section
      aria-label="Chat"
      style={docked ? { width } : undefined}
      // nokey: Backspace/Delete typed in the composer must not delete canvas items.
      className={cn(
        "nokey pointer-events-auto flex flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground",
        docked
          ? "relative ml-1.5 h-full max-w-[60vw] min-w-80 shadow-xs"
          : "absolute right-3 bottom-3 z-30 shadow-2xl shadow-black/30",
        !docked && (actions.expanded ? "top-3 w-[min(760px,calc(100%-1.5rem))]" : "h-[min(600px,calc(100%-1.5rem))] w-[min(420px,calc(100%-1.5rem))]"),
      )}
      onKeyDown={(e) => {
        // Esc minimises, unless something inside (a menu, the permission card) used it or a dictation is on: its own
        // Esc handler (on window, so after this one) cancels the dictation.
        if (e.key === "Escape" && !e.defaultPrevented && !isDictationActive(useVoiceStore.getState().state)) {
          e.preventDefault();
          actions.onMinimize();
        }
      }}
    >
      {docked && <ResizeHandle width={width} onResize={setWidth} />}
      <ChatHeader sessionId={sessionId} actions={actions} />
      <ChatConversation sessionId={sessionId} />
    </section>
  );
}

const DOCK_WIDTH_KEY = "pg.chat.dockWidth";
const DOCK_MIN_WIDTH = 320;
const DOCK_DEFAULT_WIDTH = 440;

function readDockWidth(): number {
  try {
    const n = Number(localStorage.getItem(DOCK_WIDTH_KEY));
    return Number.isFinite(n) && n >= DOCK_MIN_WIDTH ? n : DOCK_DEFAULT_WIDTH;
  } catch {
    return DOCK_DEFAULT_WIDTH;
  }
}

/** The docked panel's left edge: drag (or ←/→) to resize; the width is remembered per browser. */
function ResizeHandle({ width, onResize }: { width: number; onResize(width: number): void }) {
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, DOCK_MIN_WIDTH), window.innerWidth * 0.6));
  const commit = (w: number) => {
    onResize(w);
    try {
      localStorage.setItem(DOCK_WIDTH_KEY, String(w));
    } catch {
      // Storage unavailable: the width lasts for this page only.
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat"
      aria-valuenow={width}
      aria-valuemin={DOCK_MIN_WIDTH}
      tabIndex={0}
      className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        let last = startWidth;
        const move = (ev: PointerEvent) => {
          last = clamp(startWidth + startX - ev.clientX);
          onResize(last);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.cursor = "";
          commit(last);
        };
        document.body.style.cursor = "col-resize";
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        commit(clamp(width + (e.key === "ArrowLeft" ? 32 : -32)));
      }}
    />
  );
}

/** One session's conversation: messages with streamed text and folded tool calls, the permission card, a status line and the composer. */
export function ChatConversation({ sessionId }: { sessionId: string }) {
  const chatApi = getChatStore(useView().repoId);
  const view = useChat((s) => s.views[sessionId]) ?? EMPTY_VIEW;
  const error = useChat((s) => s.error);
  // Parallel tool calls may open several prompts: they are answered one at a time, oldest first.
  const pending = view.pendingPermissions[0];

  return (
    <>
      {error && (
        <p role="alert" className="border-b bg-red-500/10 px-3 py-1.5 text-xs text-red-700">
          {error}
        </p>
      )}
      {/* Keyed by session: the scroll position, stick-to-bottom flag and draft belong to one chat. */}
      <MessageList key={`list-${sessionId}`} sessionId={sessionId} view={view} />
      {pending && (
        <div className="max-h-[70%] shrink-0 overflow-y-auto border-t p-2">
          <PendingPrompt sessionId={sessionId} request={pending} queued={view.pendingPermissions.length - 1} />
        </div>
      )}
      <StatusLine status={view.status} warning={view.warning} question={pending?.toolName === ASK_USER_QUESTION_TOOL} />
      <ReplyAnnouncer key={`announce-${sessionId}`} view={view} />
      <Composer key={`composer-${sessionId}`} sessionId={sessionId} status={view.status} />
    </>
  );
}

/** The prompt Claude waits on: a question card for AskUserQuestion, else Allow / Deny. */
function PendingPrompt({ sessionId, request, queued }: { sessionId: string; request: ChatPermissionRequestItem; queued: number }) {
  const chat = getChatStore(useView().repoId).getState();
  const questions = request.toolName === ASK_USER_QUESTION_TOOL ? parseAskUserQuestion(request.input) : null;
  if (questions) {
    return (
      <QuestionCard
        key={request.requestId}
        request={request}
        questions={questions}
        queued={queued}
        onSubmit={(answers) => chat.answerPermission(sessionId, request.requestId, true, undefined, answers)}
        onSkip={() => chat.answerPermission(sessionId, request.requestId, false)}
      />
    );
  }
  return (
    <PermissionCard
      key={request.requestId}
      request={request}
      queued={queued}
      onAnswer={(allow) => chat.answerPermission(sessionId, request.requestId, allow, allow ? undefined : "Denied by the user")}
    />
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

function ChatHeader({ sessionId, actions }: { sessionId: string; actions: ChatWindowActions }) {
  const view = useView();
  const chatApi = getChatStore(view.repoId);
  const session = useChat((s) => s.sessions.find((x) => x.id === sessionId));
  const [confirmDelete, setConfirmDelete] = useState(false);
  // §23.2: on a subscription the chat's cost is an API-price equivalent, not money spent.
  const subscription = useRepoCache(view.repoId, (s) => s.claudeAuth?.billingMode === "subscription");
  const cost = (usd: number) => (subscription ? `≈${formatCost(usd)}` : formatCost(usd));
  const title = chatTitle(session);

  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-b pr-1.5 pl-3">
      <h2 className="min-w-0 truncate text-sm font-medium" title={title}>
        {title}
      </h2>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Chat actions" className="shrink-0 text-muted-foreground">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {session && (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              {formatDateTime(session.createdAt)} ·{" "}
              <span title={subscription ? "Cost of this chat at API prices; included in your Claude subscription" : "Total cost of this chat (estimated at API prices)"}>
                {cost(session.totalCostUsd)}
              </span>
            </div>
          )}
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Icons.trash /> Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ml-auto flex shrink-0 items-center">
        <IconAction label="Minimize (Esc)" onClick={actions.onMinimize}>
          <MinusIcon />
        </IconAction>
        <IconAction label={actions.expanded ? "Float over the canvas" : "Open as side panel"} onClick={actions.onToggleExpanded}>
          {actions.expanded ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
        </IconAction>
        <IconAction label="Close chat" onClick={actions.onClose}>
          <XIcon />
        </IconAction>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete chat"
          message={`Delete "${title}"? Its Claude Code process is stopped; the transcript stays in ~/.claude.`}
          confirmLabel="Delete"
          onConfirm={() => void chatApi.getState().deleteSession(sessionId)}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

/** A session's title as shown in the bar and the window ("New chat" until its first message). */
export function chatTitle(session: { title: string } | undefined): string {
  return session?.title || "New chat";
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

function MessageList({ sessionId, view }: { sessionId: string; view: ChatSessionView }) {
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
      {!view.loading && !view.loadError && view.items.length === 0 && view.streamingOrder.length === 0 && <EmptyState sessionId={sessionId} status={view.status} />}
      <ChatItems view={view} thinking={view.status === "thinking" || view.status === "starting"} />
    </div>
  );
}

/** Starters of an empty chat. Planning ones make Claude ask about the graph's complexity first (§21.2). */
const STARTERS: { label: string; text: string; needsGraph?: boolean }[] = [
  { label: "Plan a new graph", text: "Help me plan a new graph for this repository." },
  { label: "Plan from an idea", text: "I want to build something new. Ask me what it is and how complex the graph should be, then plan it." },
  { label: "Improve this graph", text: "Review the graph on screen and suggest improvements.", needsGraph: true },
  { label: "Add a test-fix loop", text: "Add a test-fix loop to the graph on screen.", needsGraph: true },
];

function EmptyState({ sessionId, status }: { sessionId: string; status: ChatStatus }) {
  const view = useView();
  const hasGraph = useEditor((s) => s.graph !== null);
  const connected = useDaemonStore((s) => s.connection === "open");
  const starters = STARTERS.filter((s) => !s.needsGraph || hasGraph);
  return (
    <div className="space-y-3 py-6 text-center text-xs text-muted-foreground">
      <p className="text-sm font-medium text-foreground">Design graphs with Claude</p>
      <p>Describe what you want to build: Claude asks how complex the graph should be, then drafts it. Or ask it to change the graph on screen.</p>
      <div className="flex flex-wrap justify-center gap-1.5" aria-label="Suggestions">
        {starters.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={!connected || isBusy(status)}
            onClick={() => void sendChatMessage(view, sessionId, s.text)}
            className="rounded-full px-2.5 py-1 text-xs text-foreground ring-1 ring-border transition-colors hover:bg-muted disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const STATUS_TEXT: Partial<Record<ChatStatus, string>> = {
  starting: "Starting Claude Code…",
  // Shown inline in the conversation (ChatItems "Thinking…"); here only for screen readers.
  thinking: "Claude is working…",
  waiting_permission: "Waiting for your permission",
  exited: "Session paused: it resumes on the next message.",
  error: "The Claude Code process failed.",
};

function StatusLine({ status, warning, question = false }: { status: ChatStatus; warning: string | null; question?: boolean }) {
  const text = status === "waiting_permission" && question ? "Waiting for your answer" : STATUS_TEXT[status];
  const visible = !!text && status !== "thinking";
  // Always mounted (possibly empty): screen readers announce changes of an existing live region only.
  return (
    <div role="status" className={cn("space-y-0.5 px-3 text-[11px]", (visible || warning) && "border-t py-1")}>
      {text && (
        <p
          className={cn(
            "flex items-center gap-1.5",
            status === "error" ? "text-red-700" : status === "waiting_permission" ? "text-amber-700" : "text-muted-foreground",
            !visible && "sr-only",
          )}
        >
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

function Composer({ sessionId, status }: { sessionId: string; status: ChatStatus }) {
  const view = useView();
  const chatApi = getChatStore(view.repoId);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const connected = useDaemonStore((s) => s.connection === "open");
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
      if (await sendChatMessage(view, sessionId, value)) setText("");
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
        {busy ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" size="icon" aria-label="Stop" onClick={() => chatApi.getState().interrupt(sessionId)}>
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
  const view = useView();
  useEditor((s) => s.graph?.id);
  useEditor((s) => s.graph?.name);
  useEditor((s) => s.selectedNodeIds);
  useEditor((s) => s.selectedEdgeIds);
  useEditor((s) => s.activeRunId);
  useEditor((s) => s.graph?.issues);
  useRun((s) => s.selectedRunId);
  useRun((s) => s.selectedNodeId);
  const ctx = currentChatContext(view);
  const parts: string[] = [];
  const nodes = ctx.selectedNodeIds.length;
  const edges = ctx.selectedEdgeIds.length;
  if (nodes === 1) parts.push(`node ${ctx.selectedNodeIds[0]}`);
  else if (nodes > 1) parts.push(`${nodes} nodes`);
  if (edges) parts.push(edges === 1 ? "1 edge" : `${edges} edges`);
  if (ctx.runId) parts.push("run");
  const issues = ctx.issues ?? [];
  if (issues.length) parts.push(issues.length <= 2 ? issues.join(", ") : `${issues[0]} +${issues.length - 1} issues`);
  if (ctx.graphId && ctx.readOnly) parts.push("read-only");
  const title = ctx.graphId
    ? `Sent with each message: graph ${ctx.graphId}${nodes ? `, selected nodes ${ctx.selectedNodeIds.join(", ")}` : ""}${edges ? `, selected edges ${ctx.selectedEdgeIds.join(", ")}` : ""}${ctx.runId ? `, run ${ctx.runId}` : ""}${issues.length ? `, linked issues ${issues.join(", ")} (with their Linear descriptions)` : ""}`
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
