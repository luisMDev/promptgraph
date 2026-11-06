import type { VoiceUnavailableReason } from "@promptgraph/shared";
import { MicIcon, MicOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatElapsed } from "../../lib/voice/pcm";
import type { Dictation } from "../../lib/voice/use-dictation";
import { useView } from "../../store/view/context";
import { useVoiceStore } from "../../store/voice-store";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";

/** Voice dictation pieces of the chat composer (DESIGN §22.6): mic button, unavailable popover, preview, status. */

export const REASON_TEXT: Record<VoiceUnavailableReason, string> = {
  binary_not_found: "whisper.cpp (whisper-cli) was not found.",
  model_not_found: "No whisper model (ggml-*.bin) was found.",
  binary_failed: "whisper-cli was found but does not run.",
};

export function shortcutHint(mode: "hold" | "tap"): string {
  return mode === "hold" ? "Hold to dictate, or hold Space on an empty message / Alt+Space" : "Click to dictate, or press Space on an empty message / Alt+Space";
}

export function MicButton({ dictation, disabled }: { dictation: Dictation; disabled: boolean }) {
  const { state, active, level, elapsedMs, mode } = dictation;
  const recording = state === "recording";
  const unavailable = useVoiceStore((s) => s.status !== null && !s.status.available);
  const label = active ? (state === "transcribing" ? "Transcribing dictation" : "Stop dictation") : "Dictate";
  const tooltip = disabled
    ? "Dictation needs the connection to the promptgraph server"
    : active
      ? state === "transcribing"
        ? "Transcribing…"
        : "Stop (release, click again or Space) · cancel (Esc)"
      : shortcutHint(mode);

  return (
    <Popover open={dictation.unavailableOpen} onOpenChange={dictation.setUnavailableOpen}>
      <div className="flex shrink-0 flex-col items-center gap-0.5">
        {recording && (
          <span className="font-mono text-[10px] text-muted-foreground tabular-nums" data-testid="dictation-elapsed">
            {formatElapsed(elapsedMs)}
          </span>
        )}
        <PopoverAnchor asChild>
          <span className="inline-flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={active ? "danger" : "ghost"}
                  size="icon"
                  aria-label={label}
                  aria-pressed={active}
                  aria-keyshortcuts="Alt+Space"
                  // aria-disabled, not disabled: a disabled button gets no hover/focus, so the tooltip saying why
                  // could never open. The handlers ignore input while disabled.
                  aria-disabled={disabled || undefined}
                  aria-describedby={disabled ? "dictation-disabled-reason" : undefined}
                  className={cn(
                    "relative touch-none overflow-hidden select-none",
                    !active && "text-muted-foreground",
                    disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                  )}
                  {...dictation.micHandlers}
                >
                  {recording && (
                    // Level meter: fills from the bottom with the RMS of the last block.
                    <span
                      aria-hidden="true"
                      data-testid="dictation-level"
                      className="absolute inset-x-0 bottom-0 bg-white/30 transition-[height] duration-75"
                      style={{ height: `${Math.min(100, Math.round(Math.sqrt(level) * 220))}%` }}
                    />
                  )}
                  {state === "transcribing" ? <Icons.refresh className="relative animate-spin" /> : unavailable ? <MicOffIcon className="relative" /> : <MicIcon className="relative" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{tooltip}</TooltipContent>
            </Tooltip>
            {disabled && (
              <span id="dictation-disabled-reason" className="sr-only">
                {tooltip}
              </span>
            )}
          </span>
        </PopoverAnchor>
      </div>
      <PopoverContent side="top" align="end" className="w-96" aria-label="Voice dictation unavailable">
        <VoiceUnavailable />
      </PopoverContent>
    </Popover>
  );
}

/** Why dictation cannot run and how to set it up (promptgraph never downloads whisper or a model itself). */
export function VoiceUnavailable() {
  const view = useView();
  const status = useVoiceStore((s) => s.status);
  const loading = useVoiceStore((s) => s.statusLoading);
  const statusError = useVoiceStore((s) => s.statusError);
  return (
    <div className="space-y-2.5 text-xs">
      <div>
        <p className="text-sm font-medium">Voice dictation is not set up</p>
        <p className="mt-1 text-muted-foreground">
          {status?.available
            ? "whisper.cpp is ready: dictation is available."
            : status?.reason
              ? REASON_TEXT[status.reason]
              : statusError
                ? `Could not read the voice status: ${statusError}`
                : "Checking whisper.cpp…"}
        </p>
        {status?.detail && !status.available && <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">{status.detail}</p>}
      </div>
      <p className="text-muted-foreground">Dictation runs whisper.cpp on this machine; audio never leaves it. To install it:</p>
      <SetupLines lines={status?.setup ?? []} />
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="px-1.5 text-xs"
          onClick={() => {
            view.ui.getState().setSettingsOpen(false);
            window.dispatchEvent(new CustomEvent(OPEN_VOICE_SETTINGS_EVENT));
          }}
        >
          Set paths…
        </Button>
        <Button variant="secondary" size="sm" className="gap-1.5" disabled={loading} onClick={() => void useVoiceStore.getState().loadStatus(true)}>
          <Icons.refresh className={cn("size-3.5", loading && "animate-spin")} /> Check again
        </Button>
      </div>
    </div>
  );
}

/** Window event that opens the voice settings dialog (SettingsMenu listens). */
export const OPEN_VOICE_SETTINGS_EVENT = "pg:open-voice-settings";

export function SetupLines({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <ol className="space-y-1" aria-label="Setup instructions">
      {lines.map((line) =>
        line.startsWith("#") ? (
          <li key={line} className="px-1 text-[11px] text-muted-foreground">
            {line.replace(/^#\s?/, "")}
          </li>
        ) : (
          <li key={line} className="flex items-center gap-1.5 rounded-md border bg-muted/50 py-1 pr-1 pl-2">
            <code className="min-w-0 flex-1 font-mono text-[11px] break-all">{line}</code>
            <CopyLine text={line} />
          </li>
        ),
      )}
    </ol>
  );
}

function CopyLine({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={state === "copied" ? `Copied: ${text}` : state === "failed" ? "Copy failed: select the text" : `Copy: ${text}`}
      className="shrink-0"
      onClick={() => {
        const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
        if (!clipboard) return setState("failed");
        clipboard.writeText(text).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      {state === "copied" ? <Icons.check /> : <Icons.copy />}
    </Button>
  );
}

/**
 * The composer text as it will read after the dictation: the partial transcript appears dimmed at the insertion
 * point. Shares the textarea's grid cell (whose own text is made transparent meanwhile), in flow, so a partial
 * longer than the textarea grows the composer (up to max-h-48) instead of being clipped; past that it keeps the
 * end of the partial in view. The value itself is untouched.
 */
export function DictationPreview({
  value,
  insertion,
  partial,
  textarea,
}: {
  value: string;
  insertion: { start: number; end: number };
  partial: string;
  textarea: HTMLTextAreaElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const partialRef = useRef<HTMLSpanElement>(null);
  const before = value.slice(0, insertion.start);
  const after = value.slice(insertion.end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const span = partialRef.current;
    // Keep the newest words visible: scroll so the end of the partial is at the bottom when it overflows.
    const end = span ? span.offsetTop + span.offsetHeight : 0;
    box.scrollTop = end > box.clientHeight ? end - box.clientHeight : (textarea?.scrollTop ?? 0);
  });
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="dictation-preview"
      className="pointer-events-none relative [grid-area:1/1] max-h-48 min-h-14 overflow-hidden rounded-lg border border-transparent px-2.5 py-2 text-sm break-words whitespace-pre-wrap"
    >
      {before}
      <span ref={partialRef} className="text-muted-foreground italic">
        {lead}
        {partial}
      </span>
      {trail}
      {after}
    </div>
  );
}

const STATE_TEXT = {
  requesting_mic: "Waiting for the microphone…",
  recording: "Listening",
  transcribing: "Transcribing…",
} as const;

/** One line under the composer: what dictation is doing, its last notice or error. Also the polite live region. */
export function DictationStatus({ dictation }: { dictation: Dictation }) {
  const { state, error, notice, mode } = dictation;
  const holding = mode === "hold";
  const text =
    state === "error"
      ? error
      : state === "recording"
        ? `${STATE_TEXT.recording}${holding ? "" : " · Space or the mic button stops"} · Esc cancels`
        : state === "requesting_mic" || state === "transcribing"
          ? STATE_TEXT[state]
          : notice;
  return (
    <div aria-live="polite" data-testid="dictation-status" className="min-h-0 text-[11px]">
      {text && (
        <p className={cn("flex items-center gap-1.5", state === "error" ? "text-red-700" : "text-muted-foreground")}>
          {state === "recording" && <span className="size-1.5 animate-pulse rounded-full bg-red-600" aria-hidden="true" />}
          <span className="min-w-0 flex-1">{text}</span>
          {(state === "error" || (state === "idle" && notice)) && (
            <button type="button" className="shrink-0 underline-offset-2 hover:underline" onClick={dictation.dismiss}>
              Dismiss
            </button>
          )}
        </p>
      )}
    </div>
  );
}
