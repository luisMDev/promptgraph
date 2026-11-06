import type { VoiceMode } from "@promptgraph/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type MouseEvent, type RefObject } from "react";
import { useEditorStore } from "../../store/editor-store";
import { isDictationActive, useVoiceStore, type DictationState } from "../../store/voice-store";
import { dictationKeyterms } from "./keyterms";
import { insertTranscript } from "./pcm";

/**
 * Composer side of voice dictation (DESIGN §21.6), with Claude Code's /voice UX:
 * - Space on an empty composer: hold mode = hold while speaking, release ends; tap mode = press to start and stop.
 * - Alt+Space at any time (also with text): same, in the configured mode.
 * - Mic button: press and hold = hold, click = tap toggle.
 * - Esc cancels: the composer keeps the text it had (the partial transcript is a preview, never part of the value).
 * - The final transcript is inserted at the cursor saved when the recording started; it is sent only with autoSubmit.
 */

/** A mic-button press at least this long is a hold (released = stop); shorter is a click (tap toggle). */
export const HOLD_THRESHOLD_MS = 350;

export interface UseDictationOptions {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (value: string) => void;
  /**
   * Sends the composer value (autoSubmit). Returns false when it cannot send right now (Claude is still replying,
   * a send is in flight): the transcript then stays in the composer with a notice.
   */
  submit: (value: string) => boolean;
  /** The chat cannot be used (socket down): no dictation. */
  disabled: boolean;
}

export interface Dictation {
  state: DictationState;
  active: boolean;
  partial: string;
  level: number;
  elapsedMs: number;
  error: string | null;
  notice: string | null;
  /** Configured (resolved) mode of the keyboard shortcuts. */
  mode: VoiceMode;
  /** The status is known and whisper is usable. */
  available: boolean;
  /** Selection [start, end) where the transcript goes (valid while active). */
  insertion: { start: number; end: number } | null;
  unavailableOpen: boolean;
  setUnavailableOpen: (open: boolean) => void;
  /** Composer key handlers; they return true when they consumed the event. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onKeyUp: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Mic button handlers. */
  micHandlers: {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => void;
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  };
  cancel: () => void;
  dismiss: () => void;
}

function isSpace(e: KeyboardEvent): boolean {
  return e.code === "Space" || e.key === " ";
}

export function useDictation({ inputRef, value, setValue, submit, disabled }: UseDictationOptions): Dictation {
  const state = useVoiceStore((s) => s.state);
  const partial = useVoiceStore((s) => s.partial);
  const level = useVoiceStore((s) => s.level);
  const elapsedMs = useVoiceStore((s) => s.elapsedMs);
  const error = useVoiceStore((s) => s.error);
  const notice = useVoiceStore((s) => s.notice);
  const status = useVoiceStore((s) => s.status);
  const active = isDictationActive(state);
  const mode: VoiceMode = status?.mode ?? "hold";
  const available = status?.available === true;

  const [unavailableOpen, setUnavailableOpen] = useState(false);
  const [insertion, setInsertion] = useState<{ start: number; end: number } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;
  /** The key (Space) or pointer that holds a hold-mode recording; releasing it stops. */
  const holding = useRef<"key" | "pointer" | null>(null);
  const pointerDownAt = useRef<number | null>(null);
  /** Bumped when a begin is superseded before it reaches the store (released while the status was loading). */
  const beginSeq = useRef(0);
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    void useVoiceStore.getState().loadStatus();
  }, []);

  // Unmounting the composer (panel closed, session switched) drops a recording in progress.
  useEffect(
    () => () => {
      if (isDictationActive(useVoiceStore.getState().state)) useVoiceStore.getState().cancel();
    },
    [],
  );

  // Releasing a held key outside the page (focus lost) never fires keyup here. While the browser still asks for
  // the microphone, its permission prompt may take the focus: keep that recording going (as tap) instead.
  useEffect(() => {
    const onBlur = () => {
      if (!holding.current) return;
      holding.current = null;
      if (useVoiceStore.getState().state !== "requesting_mic") useVoiceStore.getState().stop();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const el = inputRef.current;
    if (caret === null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [value, inputRef]);

  const begin = useCallback(
    async (recordMode: VoiceMode, by: "key" | "pointer" | "click") => {
      if (disabled) return;
      const seq = ++beginSeq.current;
      if (recordMode === "hold" && by !== "click") holding.current = by;
      let current = useVoiceStore.getState().status;
      if (!current?.available) current = await useVoiceStore.getState().loadStatus(!current?.available);
      if (seq !== beginSeq.current) return;
      if (!current?.available) {
        holding.current = null;
        setUnavailableOpen(true);
        return;
      }
      // A hold released while the status was loading never starts.
      if (recordMode === "hold" && by !== "click" && holding.current === null) return;
      const el = inputRef.current;
      const len = valueRef.current.length;
      const start = el ? Math.min(el.selectionStart ?? len, len) : len;
      const end = el ? Math.min(el.selectionEnd ?? len, len) : len;
      const at = { start, end };
      setInsertion(at);
      const started = await useVoiceStore.getState().start({
        mode: recordMode,
        keyterms: dictationKeyterms(useEditorStore.getState().graph),
        onFinal: (text, result) => {
          setInsertion(null);
          if (!text) return;
          const next = insertTranscript(valueRef.current, at.start, at.end, text);
          pendingCaret.current = next.caret;
          setValueRef.current(next.value);
          if (result.autoSubmit && !submitRef.current(next.value)) {
            useVoiceStore.getState().setNotice("Not sent automatically: Claude is still busy. Press Enter to send it.");
          }
        },
      });
      if (!started) {
        holding.current = null;
        setInsertion(null);
      }
    },
    [disabled, inputRef],
  );

  const stop = useCallback(() => {
    beginSeq.current++;
    holding.current = null;
    useVoiceStore.getState().stop();
  }, []);

  const cancel = useCallback(() => {
    beginSeq.current++;
    holding.current = null;
    setInsertion(null);
    useVoiceStore.getState().cancel();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing) return false;
    if (e.key === "Escape" && (active || holding.current)) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return true;
    }
    if (!isSpace(e) || e.ctrlKey || e.metaKey) return false;
    const alt = e.altKey;
    if (!alt && (e.shiftKey || (valueRef.current !== "" && !active))) return false;
    // Plain Space types a space unless dictation can actually start (status known, whisper available).
    if (!alt && !active && (!available || disabled)) return false;
    e.preventDefault();
    if (e.repeat) return true;
    if (active || holding.current) {
      // Hold mode ends on keyup; in tap mode (or a click-started recording) this press stops it.
      if (holding.current !== "key") stop();
      return true;
    }
    void begin(mode, "key");
    return true;
  };

  const onKeyUp = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (holding.current !== "key" || !isSpace(e)) return false;
    e.preventDefault();
    // Released while the browser asks for the microphone (the user lets go of Space to click Allow): keep
    // recording as tap, like the mic button does, instead of cancelling the first-time dictation.
    if (useVoiceStore.getState().state === "requesting_mic") {
      holding.current = null;
      return true;
    }
    stop();
    return true;
  };

  /** A mic-button press ends: a click (or a release during the permission prompt) keeps recording as tap. */
  const releasePointer = () => {
    const downAt = pointerDownAt.current;
    pointerDownAt.current = null;
    if (downAt === null || holding.current !== "pointer") return;
    const s = useVoiceStore.getState().state;
    if (Date.now() - downAt < HOLD_THRESHOLD_MS || s === "requesting_mic") {
      holding.current = null;
      return;
    }
    stop();
  };
  const releasePointerRef = useRef(releasePointer);
  releasePointerRef.current = releasePointer;

  // A hold released off the button (dragged away while speaking) never reaches its onPointerUp: listen on the
  // window too. The button's own pointerup runs first and clears pointerDownAt, so this is then a no-op.
  useEffect(() => {
    const onUp = (e: globalThis.PointerEvent) => {
      if (e.button === 0) releasePointerRef.current();
    };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, []);

  // Esc (and Alt+Space) while dictating work wherever the focus is (e.g. on the mic button after a keyboard
  // activation); the textarea handles them itself and stops their propagation.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.target === inputRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.altKey && (e.code === "Space" || e.key === " ") && !e.repeat) {
        e.preventDefault();
        if (useVoiceStore.getState().state !== "transcribing") stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, cancel, stop, inputRef]);

  const micHandlers: Dictation["micHandlers"] = {
    onPointerDown: (e) => {
      if (e.button !== 0 || disabled) return;
      e.preventDefault(); // keep the focus (and the caret) in the composer
      try {
        // Deliver the release to the button even when the pointer leaves it.
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // No active pointer with that id (synthetic events): the window listener covers the release.
      }
      if (active || holding.current) {
        if (useVoiceStore.getState().state !== "transcribing") stop();
        pointerDownAt.current = null;
        return;
      }
      pointerDownAt.current = Date.now();
      void begin("hold", "pointer");
    },
    onPointerUp: (e) => {
      if (e.button !== 0) return;
      releasePointer();
    },
    onPointerCancel: () => {
      pointerDownAt.current = null;
      if (holding.current === "pointer") stop();
    },
    onClick: (e) => {
      // Pointer clicks are handled by pointerdown/up; this is the keyboard activation (Enter / Space on the button).
      if (e.detail !== 0 || disabled) return;
      if (active) {
        if (state !== "transcribing") stop();
        return;
      }
      void begin("tap", "click");
    },
  };

  return {
    state,
    active,
    partial,
    level,
    elapsedMs,
    error,
    notice,
    mode,
    available,
    insertion: active ? insertion : null,
    unavailableOpen,
    setUnavailableOpen,
    onKeyDown,
    onKeyUp,
    micHandlers,
    cancel,
    dismiss: () => useVoiceStore.getState().dismiss(),
  };
}
