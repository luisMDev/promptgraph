import {
  VOICE_LANGUAGE_AUTO,
  VoiceSettingsSchema,
  WHISPER_LANGUAGES,
  type VoiceDefaultSource,
  type VoiceMode,
  type VoiceSettings,
  type VoiceStatus,
} from "@promptgraph/shared";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { errorMessage } from "../../api/rest";
import { useDaemonStore } from "../../store/daemon-store";
import { useVoiceStore } from "../../store/voice-store";
import { REASON_TEXT, SetupLines } from "../chat/Dictation";
import { OptionalNumber, OptionalText, Select } from "../common/fields";
import { Icons } from "../common/icons";
import { Button, Field, Modal } from "../common/ui";

/**
 * "Voice dictation" settings (DESIGN §22.3): whisper binary and model paths, mode, language, auto-submit and
 * threads, saved as AppSettings.voice (PUT /api/settings replaces the object as a whole). Empty fields mean "use the
 * default" (promptgraph setting > Claude Code's ~/.claude/settings.json > built-in fallback), shown with its source.
 */

const SOURCE_TEXT: Record<VoiceDefaultSource, string> = {
  promptgraph: "this setting",
  claude: "Claude Code settings",
  fallback: "built-in default",
};

const LANGUAGE_OPTIONS = Object.entries(WHISPER_LANGUAGES)
  .map(([code, name]) => ({ value: code, label: `${name[0]!.toUpperCase()}${name.slice(1)} (${code})` }))
  .sort((a, b) => a.label.localeCompare(b.label));

interface Draft {
  whisperBin?: string;
  model?: string;
  mode: "" | VoiceMode;
  language: string;
  autoSubmit: "" | "on" | "off";
  threads?: number;
}

function toDraft(v: VoiceSettings | undefined): Draft {
  return {
    whisperBin: v?.whisperBin,
    model: v?.model,
    mode: v?.mode ?? "",
    language: v?.language ?? "",
    autoSubmit: v?.autoSubmit === undefined ? "" : v.autoSubmit ? "on" : "off",
    threads: v?.threads,
  };
}

/** Draft → VoiceSettings (absent = default). */
export function draftToVoiceSettings(d: Draft): VoiceSettings {
  const out: VoiceSettings = {};
  if (d.whisperBin?.trim()) out.whisperBin = d.whisperBin.trim();
  if (d.model?.trim()) out.model = d.model.trim();
  if (d.mode) out.mode = d.mode;
  if (d.language) out.language = d.language;
  if (d.autoSubmit) out.autoSubmit = d.autoSubmit === "on";
  if (d.threads !== undefined) out.threads = d.threads;
  return out;
}

export function VoiceSettingsDialog({ onClose }: { onClose: () => void }) {
  const saved = useDaemonStore((s) => s.settings?.voice);
  const status = useVoiceStore((s) => s.status);
  const loading = useVoiceStore((s) => s.statusLoading);
  const [draft, setDraft] = useState<Draft>(() => toDraft(saved));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  useEffect(() => {
    void useVoiceStore.getState().loadStatus(true);
  }, []);

  const save = async () => {
    const parsed = VoiceSettingsSchema.safeParse(draftToVoiceSettings(draft));
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${i.path.join(".") || "voice"}: ${i.message}`));
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      await useDaemonStore.getState().updateSettings({ voice: parsed.data });
      await useVoiceStore.getState().loadStatus(true);
      onClose();
    } catch (err) {
      setErrors([`Could not save: ${errorMessage(err)}`]);
    } finally {
      setSaving(false);
    }
  };

  const from = status?.defaultsFrom;
  const defaultOf = (field: "mode" | "language" | "autoSubmit", value: string) =>
    status && from ? `Default: ${value} (${SOURCE_TEXT[from[field]]})` : "Default";
  // With a saved value the status shows it, not the default: the default label then only names the source chain.
  const modeDefault = saved?.mode === undefined && status ? defaultOf("mode", status.mode) : "Default (Claude Code's voice.mode, else hold)";
  const languageDefault =
    saved?.language === undefined && status
      ? defaultOf("language", status.language === VOICE_LANGUAGE_AUTO ? "auto-detect" : (WHISPER_LANGUAGES[status.language] ?? status.language))
      : "Default (Claude Code's language, else auto-detect)";
  const autoSubmitDefault =
    saved?.autoSubmit === undefined && status ? defaultOf("autoSubmit", status.autoSubmit ? "on" : "off") : "Default (Claude Code's voice.autoSubmit, else off)";

  return (
    <Modal
      title="Voice dictation"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <VoiceStatusSummary status={status} loading={loading} />
        <Field label="whisper-cli binary" hint="Absolute path. Empty: whisper-cli, then whisper-cpp, on PATH.">
          <OptionalText value={draft.whisperBin} mono placeholder={status?.whisperBinFrom === "path" ? status.whisperBin : "/home/you/whisper.cpp/build/bin/whisper-cli"} onChange={(whisperBin) => update({ whisperBin })} />
        </Field>
        <Field label="Model" hint="Absolute path of a ggml .bin. Empty: the first of ~/.promptgraph/models/ggml-*.bin, then ~/whisper.cpp/models/ggml-{small,base,medium,large-v3-turbo}*.bin.">
          <OptionalText value={draft.model} mono placeholder={status?.modelFrom === "detected" ? status.model : "/home/you/whisper.cpp/models/ggml-small.bin"} onChange={(model) => update({ model })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Mode" hint="Space / Alt+Space: hold while speaking, or tap to start and stop.">
            <Select<Draft["mode"]>
              value={draft.mode}
              options={[
                { value: "", label: modeDefault },
                { value: "hold", label: "Hold" },
                { value: "tap", label: "Tap" },
              ]}
              onChange={(mode) => update({ mode })}
            />
          </Field>
          <Field label="Send automatically" hint="Send the message when the transcript arrives.">
            <Select<Draft["autoSubmit"]>
              value={draft.autoSubmit}
              options={[
                { value: "", label: autoSubmitDefault },
                { value: "off", label: "Off: review, then Enter" },
                { value: "on", label: "On" },
              ]}
              onChange={(autoSubmit) => update({ autoSubmit })}
            />
          </Field>
          <Field label="Language">
            <Select<string>
              value={draft.language}
              options={[{ value: "", label: languageDefault }, { value: VOICE_LANGUAGE_AUTO, label: "Auto-detect" }, ...LANGUAGE_OPTIONS]}
              onChange={(language) => update({ language })}
            />
          </Field>
          <Field label="Threads" hint="whisper-cli -t. Empty: whisper's default.">
            <OptionalNumber value={draft.threads} min={1} max={64} onChange={(threads) => update({ threads: threads === undefined ? undefined : Math.round(threads) })} />
          </Field>
        </div>
        {errors.length > 0 && (
          <ul role="alert" className="space-y-0.5 text-xs text-red-700">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function VoiceStatusSummary({ status, loading }: { status: VoiceStatus | null; loading: boolean }) {
  const statusError = useVoiceStore((s) => s.statusError);
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-xs" data-testid="voice-status">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", status?.available ? "bg-emerald-500" : status ? "bg-amber-500" : "bg-muted-foreground/50")} aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium">
          {status ? (status.available ? "Ready: whisper.cpp runs on this machine" : (status.reason ? REASON_TEXT[status.reason] : "Unavailable")) : statusError ? `Status unavailable: ${statusError}` : "Checking…"}
        </span>
        <Button variant="ghost" size="xs" className="gap-1" disabled={loading} onClick={() => void useVoiceStore.getState().loadStatus(true)}>
          <Icons.refresh className={cn("size-3", loading && "animate-spin")} /> Check again
        </Button>
      </div>
      {status && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
          <dt>Binary</dt>
          <dd className="truncate font-mono" title={status.whisperBin}>
            {status.whisperBin ? `${status.whisperBin}${status.whisperBinFrom === "path" ? " (PATH)" : ""}` : "not found"}
          </dd>
          <dt>Model</dt>
          <dd className="truncate font-mono" title={status.model}>
            {status.model ? `${status.model}${status.modelFrom === "detected" ? " (detected)" : ""}` : "not found"}
          </dd>
        </dl>
      )}
      {status?.detail && !status.available && <p className="font-mono text-[11px] break-all text-muted-foreground">{status.detail}</p>}
      {status && !status.available && <SetupLines lines={status.setup} />}
    </div>
  );
}
