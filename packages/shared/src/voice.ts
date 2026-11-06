import { z } from "zod";

/**
 * Voice dictation in the chat composer (§21). Audio is captured in the browser, streamed to this server over
 * the WebSocket as binary PCM frames and transcribed locally by whisper.cpp (`whisper-cli`). Audio never leaves
 * the machine, is never persisted beyond a temp WAV deleted right after each pass, and is never logged.
 *
 * This file is the shared contract: settings, the GET /api/voice status, the `voice:*` WebSocket messages
 * (members of the unions in ws.ts), limits, and the pure helpers both sides use.
 */

// --- Constants -------------------------------------------------------------

/** REST path of the voice status (GET → VoiceStatus). */
export const VOICE_API_PATH = "/api/voice";

/** Audio format of the binary WS frames: little-endian Int16, mono, 16 kHz. */
export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_CHANNELS = 1;
export const VOICE_BYTES_PER_SAMPLE = 2;
/** The browser posts audio chunks of about this length. */
export const VOICE_CHUNK_MS = 100;
/** Largest binary frame the server accepts (≈ 2 s of audio); bigger frames end the session with `failed`. */
export const VOICE_MAX_FRAME_BYTES = 64 * 1024;

/** Recording cap, as in Claude Code: 2 minutes of audio. */
export const VOICE_MAX_SECONDS = 120;
/** Bytes of PCM in VOICE_MAX_SECONDS (16000 × 2 × 120). */
export const VOICE_MAX_AUDIO_BYTES = VOICE_SAMPLE_RATE * VOICE_BYTES_PER_SAMPLE * VOICE_CHANNELS * VOICE_MAX_SECONDS;
/** The browser stops the recording after this much continuous silence, as in Claude Code. */
export const VOICE_SILENCE_STOP_SECONDS = 15;
/**
 * Server-side wall-clock watchdog: a session still recording this long after voice:start (a client that never
 * sends voice:stop, or stops sending audio) is cancelled with `too_long`.
 */
export const VOICE_WATCHDOG_SECONDS = VOICE_MAX_SECONDS + 30;
/** A partial pass runs after about this much new audio, when no pass is running. */
export const VOICE_PARTIAL_INTERVAL_MS = 2000;
/** Timeout of one whisper-cli run (partial or final); the child is killed after it. */
export const VOICE_PASS_TIMEOUT_MS = 60_000;
/** GET /api/voice caches the probe (binary, model, `--help` smoke) for this long. */
export const VOICE_STATUS_CACHE_MS = 5000;

/** Keyterms biasing the transcription (passed to whisper as `--prompt`). */
export const VOICE_MAX_KEYTERMS = 50;
export const VOICE_MAX_KEYTERM_LENGTH = 60;

/** Binaries looked up on PATH, in order, when `voice.whisperBin` is not set. */
export const VOICE_WHISPER_BINARIES = ["whisper-cli", "whisper-cpp"] as const;
/** Model families tried in `~/whisper.cpp/models`, in order (`ggml-<family>*.bin`). */
export const VOICE_WHISPER_CPP_MODEL_FAMILIES = ["small", "base", "medium", "large-v3-turbo"] as const;

/**
 * Setup instructions shown in the UI (with copy buttons) and in the docs. promptgraph never downloads binaries
 * or models itself. Comment lines (`# …`) are explanations, not commands.
 */
export const VOICE_SETUP_INSTRUCTIONS: readonly string[] = [
  "sudo apt install cmake",
  "git clone https://github.com/ggml-org/whisper.cpp ~/whisper.cpp && cd ~/whisper.cpp",
  "cmake -B build && cmake --build build -j --config Release",
  "sh ./models/download-ggml-model.sh small",
  "# Then set the whisper binary to ~/whisper.cpp/build/bin/whisper-cli (or put it on PATH);",
  "# the model is auto-detected in ~/whisper.cpp/models.",
];

// --- Languages -------------------------------------------------------------

/** whisper.cpp language codes → English names (whisper's own table). */
export const WHISPER_LANGUAGES: Readonly<Record<string, string>> = {
  en: "english", zh: "chinese", de: "german", es: "spanish", ru: "russian", ko: "korean", fr: "french",
  ja: "japanese", pt: "portuguese", tr: "turkish", pl: "polish", ca: "catalan", nl: "dutch", ar: "arabic",
  sv: "swedish", it: "italian", id: "indonesian", hi: "hindi", fi: "finnish", vi: "vietnamese", he: "hebrew",
  uk: "ukrainian", el: "greek", ms: "malay", cs: "czech", ro: "romanian", da: "danish", hu: "hungarian",
  ta: "tamil", no: "norwegian", th: "thai", ur: "urdu", hr: "croatian", bg: "bulgarian", lt: "lithuanian",
  la: "latin", mi: "maori", ml: "malayalam", cy: "welsh", sk: "slovak", te: "telugu", fa: "persian",
  lv: "latvian", bn: "bengali", sr: "serbian", az: "azerbaijani", sl: "slovenian", kn: "kannada", et: "estonian",
  mk: "macedonian", br: "breton", eu: "basque", is: "icelandic", hy: "armenian", ne: "nepali", mn: "mongolian",
  bs: "bosnian", kk: "kazakh", sq: "albanian", sw: "swahili", gl: "galician", mr: "marathi", pa: "punjabi",
  si: "sinhala", km: "khmer", sn: "shona", yo: "yoruba", so: "somali", af: "afrikaans", oc: "occitan",
  ka: "georgian", be: "belarusian", tg: "tajik", sd: "sindhi", gu: "gujarati", am: "amharic", yi: "yiddish",
  lo: "lao", uz: "uzbek", fo: "faroese", ht: "haitian creole", ps: "pashto", tk: "turkmen", nn: "nynorsk",
  mt: "maltese", sa: "sanskrit", lb: "luxembourgish", my: "myanmar", bo: "tibetan", tl: "tagalog",
  mg: "malagasy", as: "assamese", tt: "tatar", haw: "hawaiian", ln: "lingala", ha: "hausa", ba: "bashkir",
  jw: "javanese", su: "sundanese", yue: "cantonese",
};

/** Let whisper detect the language. */
export const VOICE_LANGUAGE_AUTO = "auto";

export function isWhisperLanguage(code: string): boolean {
  return code === VOICE_LANGUAGE_AUTO || Object.hasOwn(WHISPER_LANGUAGES, code);
}

/** Names and aliases (lower case) accepted from Claude Code's `language` setting, besides the codes and English names. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  "español": "es", espanol: "es", castellano: "es", castilian: "es",
  "français": "fr", francais: "fr", deutsch: "de", italiano: "it", "português": "pt", portugues: "pt",
  nederlands: "nl", flemish: "nl", polski: "pl", "русский": "ru", "українська": "uk", "türkçe": "tr", turkce: "tr",
  "日本語": "ja", "中文": "zh", mandarin: "zh", "simplified chinese": "zh", "traditional chinese": "zh",
  "한국어": "ko", "العربية": "ar", "עברית": "he", "हिन्दी": "hi", "ελληνικά": "el", svenska: "sv", dansk: "da",
  norsk: "no", "norwegian bokmål": "no", "bokmål": "no", suomi: "fi", "čeština": "cs", magyar: "hu",
  "română": "ro", "català": "ca", catala: "ca", valencian: "ca", galego: "gl", euskara: "eu",
  "tiếng việt": "vi", "bahasa indonesia": "id", "bahasa melayu": "ms", farsi: "fa", burmese: "my",
  moldavian: "ro", moldovan: "ro", panjabi: "pa", pushto: "ps", sinhalese: "si", haitian: "ht",
  letzeburgesch: "lb", "cantonese chinese": "yue", filipino: "tl", javanese: "jw", jv: "jw",
};

const LANGUAGE_BY_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(WHISPER_LANGUAGES).map(([code, name]) => [name, code]),
);

/**
 * Maps Claude Code's top-level `language` setting (a free-form name such as "spanish", "Español", or a code such
 * as "es" / "es-ES" / "pt_BR") to a whisper language code. Returns null when it is not recognised, so the caller
 * falls back to "auto".
 */
export function claudeLanguageToWhisper(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return null;
  if (v === VOICE_LANGUAGE_AUTO) return VOICE_LANGUAGE_AUTO;
  if (Object.hasOwn(WHISPER_LANGUAGES, v)) return v;
  if (Object.hasOwn(LANGUAGE_BY_NAME, v)) return LANGUAGE_BY_NAME[v]!;
  if (Object.hasOwn(LANGUAGE_ALIASES, v)) return LANGUAGE_ALIASES[v]!;
  // BCP 47 / POSIX locale: "es-ES", "pt_BR", "zh-Hant-TW" → primary subtag.
  const locale = /^([a-z]{2,3})[-_][a-z0-9-_]+$/.exec(v);
  if (locale) {
    const primary = locale[1]!;
    if (primary === "jv") return "jw";
    if (Object.hasOwn(WHISPER_LANGUAGES, primary)) return primary;
  }
  // "Spanish (Spain)", "english - us" → first word.
  const head = /^([\p{L} ]+?)\s*[(\-,]/u.exec(v);
  if (head && head[1] !== v) return claudeLanguageToWhisper(head[1]);
  return null;
}

// --- Settings --------------------------------------------------------------

export const VoiceModeSchema = z.enum(["hold", "tap"]);
export type VoiceMode = z.infer<typeof VoiceModeSchema>;

/** A whisper language code or "auto". */
export const VoiceLanguageSchema = z
  .string()
  .refine(isWhisperLanguage, { message: 'Expected a whisper language code (e.g. "es") or "auto"' });

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((p) => p.startsWith("/"), { message: "Expected an absolute path" });

/**
 * `voice` in AppSettings (~/.promptgraph/settings.json). Every field is optional: absent = use the default
 * (§21.3 resolution order). PUT /api/settings replaces the `voice` object as a whole.
 */
export const VoiceSettingsSchema = z.object({
  /** Absolute path of whisper-cli. Default: VOICE_WHISPER_BINARIES on PATH. */
  whisperBin: AbsolutePathSchema.optional(),
  /** Absolute path of a ggml model (.bin). Default: auto-detected (findVoiceModel). */
  model: AbsolutePathSchema.optional(),
  /** Default: Claude Code's voice.mode, else "hold". */
  mode: VoiceModeSchema.optional(),
  /** Default: Claude Code's top-level `language` mapped to a whisper code, else "auto". */
  language: VoiceLanguageSchema.optional(),
  /** Send the message as soon as the final transcript arrives. Default: Claude Code's voice.autoSubmit, else false. */
  autoSubmit: z.boolean().optional(),
  /** whisper-cli `-t`. Default: whisper's own. */
  threads: z.number().int().min(1).max(64).optional(),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

// --- Claude Code settings (read-only input of the defaults) ----------------

/** What promptgraph reads from ~/.claude/settings.json. Each field is independent: an invalid one is dropped. */
export interface ClaudeVoicePreferences {
  enabled?: boolean;
  mode?: VoiceMode;
  autoSubmit?: boolean;
  /** Top-level `language`, raw. */
  language?: string;
}

/**
 * Lenient reader of Claude Code's settings JSON (already parsed): `voice: { enabled, mode, autoSubmit }`, the
 * legacy `voiceEnabled`, and the top-level `language`. Anything missing or of the wrong type is ignored.
 */
export function readClaudeVoicePreferences(raw: unknown): ClaudeVoicePreferences {
  const out: ClaudeVoicePreferences = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const root = raw as Record<string, unknown>;
  if (typeof root.voiceEnabled === "boolean") out.enabled = root.voiceEnabled;
  const voice = root.voice;
  if (voice && typeof voice === "object" && !Array.isArray(voice)) {
    const v = voice as Record<string, unknown>;
    if (typeof v.enabled === "boolean") out.enabled = v.enabled;
    const mode = VoiceModeSchema.safeParse(v.mode);
    if (mode.success) out.mode = mode.data;
    if (typeof v.autoSubmit === "boolean") out.autoSubmit = v.autoSubmit;
  }
  if (typeof root.language === "string" && root.language.trim()) out.language = root.language;
  return out;
}

/** Where a resolved voice preference came from. */
export const VoiceDefaultSourceSchema = z.enum(["promptgraph", "claude", "fallback"]);
export type VoiceDefaultSource = z.infer<typeof VoiceDefaultSourceSchema>;

export const VoiceDefaultsFromSchema = z.object({
  mode: VoiceDefaultSourceSchema,
  language: VoiceDefaultSourceSchema,
  autoSubmit: VoiceDefaultSourceSchema,
});
export type VoiceDefaultsFrom = z.infer<typeof VoiceDefaultsFromSchema>;

export interface ResolvedVoicePreferences {
  mode: VoiceMode;
  language: string;
  autoSubmit: boolean;
  defaultsFrom: VoiceDefaultsFrom;
}

/**
 * Resolution order per field: promptgraph setting > Claude Code preference > fallback ("hold", "auto", false).
 * A Claude Code `language` that does not map to a whisper code counts as absent.
 */
export function resolveVoicePreferences(settings: VoiceSettings | undefined, claude: ClaudeVoicePreferences): ResolvedVoicePreferences {
  const s = settings ?? {};
  const claudeLanguage = claudeLanguageToWhisper(claude.language);
  const pick = <T>(own: T | undefined, fromClaude: T | undefined | null, fallback: T): [T, VoiceDefaultSource] =>
    own !== undefined ? [own, "promptgraph"] : fromClaude !== undefined && fromClaude !== null ? [fromClaude, "claude"] : [fallback, "fallback"];
  const [mode, modeFrom] = pick<VoiceMode>(s.mode, claude.mode, "hold");
  const [language, languageFrom] = pick<string>(s.language, claudeLanguage, VOICE_LANGUAGE_AUTO);
  const [autoSubmit, autoSubmitFrom] = pick<boolean>(s.autoSubmit, claude.autoSubmit, false);
  return { mode, language, autoSubmit, defaultsFrom: { mode: modeFrom, language: languageFrom, autoSubmit: autoSubmitFrom } };
}

// --- Model auto-detection --------------------------------------------------

const VAD_MODEL = /silero|vad/i;

function familyRank(file: string): number {
  const i = VOICE_WHISPER_CPP_MODEL_FAMILIES.findIndex((f) => file.startsWith(`ggml-${f}`) && /^[.\-_]/.test(file.slice(5 + f.length)));
  return i === -1 ? VOICE_WHISPER_CPP_MODEL_FAMILIES.length : i;
}

/**
 * Orders the whisper model files of one directory: `ggml-*.bin` only, voice-activity models (silero/vad)
 * excluded, then by family (small, base, medium, large-v3-turbo, others) and name. With `familiesOnly`, files of
 * other families are dropped.
 */
export function orderVoiceModelFiles(files: readonly string[], familiesOnly = false): string[] {
  return files
    .filter((f) => /^ggml-.+\.bin$/.test(f) && !VAD_MODEL.test(f))
    .filter((f) => !familiesOnly || familyRank(f) < VOICE_WHISPER_CPP_MODEL_FAMILIES.length)
    .sort((a, b) => familyRank(a) - familyRank(b) || a.localeCompare(b));
}

export interface VoiceModelSearch {
  /** `~/.promptgraph/models`: any `ggml-*.bin`. */
  promptgraphModelsDir: string;
  /** `~/whisper.cpp/models`: `ggml-{small,base,medium,large-v3-turbo}*.bin` only. */
  whisperCppModelsDir: string;
  /** Lists the file names of a directory; [] (or a throw) when it does not exist. */
  listDir: (dir: string) => readonly string[];
}

/**
 * Model used when `voice.model` is not set: the first file of `promptgraphModelsDir` (any ggml model, ordered by
 * orderVoiceModelFiles), else the first of `whisperCppModelsDir` (small, base, medium, large-v3-turbo). Pure:
 * the caller injects listDir. Returns the absolute path, or null.
 */
export function findVoiceModel(search: VoiceModelSearch): string | null {
  const list = (dir: string): readonly string[] => {
    try {
      return search.listDir(dir);
    } catch {
      return [];
    }
  };
  const join = (dir: string, file: string) => `${dir.replace(/\/+$/, "")}/${file}`;
  const own = orderVoiceModelFiles(list(search.promptgraphModelsDir));
  if (own.length) return join(search.promptgraphModelsDir, own[0]!);
  const cpp = orderVoiceModelFiles(list(search.whisperCppModelsDir), true);
  return cpp.length ? join(search.whisperCppModelsDir, cpp[0]!) : null;
}

// --- Status (GET /api/voice) -----------------------------------------------

export const VoiceUnavailableReasonSchema = z.enum(["binary_not_found", "model_not_found", "binary_failed"]);
export type VoiceUnavailableReason = z.infer<typeof VoiceUnavailableReasonSchema>;

/** GET /api/voice → VoiceStatus. The probe is cached for VOICE_STATUS_CACHE_MS; "Check again" just refetches. */
export const VoiceStatusSchema = z.object({
  available: z.boolean(),
  /** Set when !available. */
  reason: VoiceUnavailableReasonSchema.optional(),
  /** Human-readable detail of the reason (e.g. the configured path that does not exist, the smoke-test error). */
  detail: z.string().optional(),
  /** Resolved binary (configured or found on PATH), when known. */
  whisperBin: z.string().optional(),
  whisperBinFrom: z.enum(["promptgraph", "path"]).optional(),
  /** Resolved model (configured or auto-detected), when known. */
  model: z.string().optional(),
  modelFrom: z.enum(["promptgraph", "detected"]).optional(),
  mode: VoiceModeSchema,
  /** Whisper code or "auto". */
  language: z.string(),
  autoSubmit: z.boolean(),
  /** Configured `voice.threads`, if any. */
  threads: z.number().int().positive().optional(),
  /** VOICE_SETUP_INSTRUCTIONS. */
  setup: z.array(z.string()),
  defaultsFrom: VoiceDefaultsFromSchema,
});
export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;

// --- WebSocket payloads (members of the unions in ws.ts) --------------------

/** Client-generated id of one recording. */
export const VoiceIdSchema = z.string().min(1).max(64);

export const VoiceKeytermsSchema = z.array(z.string().max(VOICE_MAX_KEYTERM_LENGTH)).max(VOICE_MAX_KEYTERMS);

/**
 * Starts a recording. Binary frames that follow on the same socket (LE Int16 mono PCM at 16 kHz) belong to it.
 * One active session per WS client: a new voice:start cancels the previous one (no message for it).
 */
export const VoiceStartMessageSchema = z.object({
  type: z.literal("voice:start"),
  voiceId: VoiceIdSchema,
  sampleRate: z.literal(VOICE_SAMPLE_RATE),
  /** Biases the transcription (whisper `--prompt`); run through sanitizeKeyterms by the client and the server. */
  keyterms: VoiceKeytermsSchema.optional(),
  /** Overrides the resolved language for this recording. */
  language: VoiceLanguageSchema.optional(),
});
/** Ends the recording: the server finishes a running pass, runs the final pass and replies voice:final. */
export const VoiceStopMessageSchema = z.object({ type: z.literal("voice:stop"), voiceId: VoiceIdSchema });
/** Drops the recording: kills whisper, deletes the temp file and the buffer. No reply. */
export const VoiceCancelMessageSchema = z.object({ type: z.literal("voice:cancel"), voiceId: VoiceIdSchema });

/** Transcript of all the audio so far (replaces the previous partial, it is not a delta). */
export const VoicePartialMessageSchema = z.object({ type: z.literal("voice:partial"), voiceId: VoiceIdSchema, text: z.string() });
/**
 * Terminal: the final transcript (may be empty). `truncated` = the recording reached VOICE_MAX_SECONDS and the
 * server stopped it by itself; the client shows the "stopped at 2 minutes" notice.
 */
export const VoiceFinalMessageSchema = z.object({
  type: z.literal("voice:final"),
  voiceId: VoiceIdSchema,
  text: z.string(),
  truncated: z.boolean().optional(),
  /**
   * Set when the text is not the result of a full final pass (it failed, and the server fell back to the last
   * good partial): a short explanation the client shows next to the inserted text.
   */
  notice: z.string().max(500).optional(),
});

/**
 * - `unavailable`: whisper or the model is missing / broken (GET /api/voice says why).
 * - `too_long`: the wall-clock watchdog (VOICE_WATCHDOG_SECONDS) ended a session that never stopped.
 * - `failed`: whisper exited non-zero or timed out, an oversized frame, any other error.
 * - `busy`: another transcription holds the global slot and the queue is full.
 * - `cancelled`: the server ended the session (shutdown). Never sent in reply to voice:cancel.
 */
export const VoiceErrorCodeSchema = z.enum(["unavailable", "too_long", "failed", "busy", "cancelled"]);
export type VoiceErrorCode = z.infer<typeof VoiceErrorCodeSchema>;

/** Terminal, like voice:final: every session ends with exactly one of the two (except after voice:cancel). */
export const VoiceErrorMessageSchema = z.object({
  type: z.literal("voice:error"),
  voiceId: VoiceIdSchema,
  code: VoiceErrorCodeSchema,
  message: z.string(),
});

// --- Pure helpers ----------------------------------------------------------

/**
 * Cleans keyterms for whisper's `--prompt`: trims and collapses whitespace, removes control characters, drops
 * empty and over-long terms (> VOICE_MAX_KEYTERM_LENGTH), de-duplicates case-insensitively (first spelling wins)
 * and keeps at most VOICE_MAX_KEYTERMS.
 */
export function sanitizeKeyterms(terms: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of terms ?? []) {
    if (out.length >= VOICE_MAX_KEYTERMS) break;
    if (typeof term !== "string") continue;
    const clean = term.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > VOICE_MAX_KEYTERM_LENGTH) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** The `--prompt` value for whisper: keyterms joined by ", ", or undefined when there are none. */
export function whisperPromptFromKeyterms(terms: readonly string[]): string | undefined {
  const clean = sanitizeKeyterms(terms);
  return clean.length ? clean.join(", ") : undefined;
}

/** Non-speech annotations whisper writes in parentheses or asterisks (bracketed ones are always dropped). */
const NON_SPEECH =
  /^(?:blank[ _]audio|silence|silent|no speech|music|music playing|soft music|upbeat music|applause|laughter|laughs|laughing|noise|background noise|static|inaudible|indistinct|unintelligible|sighs?|coughs?|coughing|breathing|clears throat|beep|beeping|wind|typing|keyboard clicking|clicking|footsteps|door closes|silencio|música|musica|ruido|risas|aplausos)$/i;

/**
 * Turns whisper-cli stdout into dictation text: drops `[hh:mm:ss.mmm --> …]` timestamps (in case `-nt` was
 * ignored), every `[…]` annotation ("[BLANK_AUDIO]", "[Music]", "[ Silence ]"), `(…)` / `*…*` annotations that
 * name a non-speech sound ("(silence)", "*music*"), and ♪ marks; joins the lines with spaces and collapses
 * whitespace. Parentheses with real words ("(see above)") are kept.
 */
export function cleanWhisperText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\(([^)]*)\)/g, (m, inner: string) => (NON_SPEECH.test(inner.trim()) ? " " : m))
        .replace(/\*([^*]*)\*/g, (m, inner: string) => (NON_SPEECH.test(inner.trim()) ? " " : m))
        .replace(/[♪♫]+/g, " "),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
