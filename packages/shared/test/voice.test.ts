import { describe, expect, it } from "vitest";
import {
  AppSettingsSchema,
  claudeLanguageToWhisper,
  cleanWhisperText,
  ClientMessageSchema,
  findVoiceModel,
  orderVoiceModelFiles,
  readClaudeVoicePreferences,
  resolveVoicePreferences,
  sanitizeKeyterms,
  ServerMessageSchema,
  UpdateAppSettingsRequestSchema,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_KEYTERMS,
  VOICE_SETUP_INSTRUCTIONS,
  VoiceSettingsSchema,
  VoiceStatusSchema,
  whisperPromptFromKeyterms,
} from "../src/index.js";

describe("voice constants", () => {
  it("caps two minutes of 16 kHz Int16 mono audio", () => {
    expect(VOICE_MAX_AUDIO_BYTES).toBe(16000 * 2 * 120);
  });

  it("ships the documented setup lines", () => {
    expect(VOICE_SETUP_INSTRUCTIONS[0]).toBe("sudo apt install cmake");
    expect(VOICE_SETUP_INSTRUCTIONS).toContain("sh ./models/download-ggml-model.sh small");
  });
});

describe("voice settings", () => {
  it("keeps settings files written before voice existed valid", () => {
    expect(AppSettingsSchema.parse({ notifications: false })).toEqual({ notifications: false });
    expect(AppSettingsSchema.parse({})).toEqual({ notifications: true });
  });

  it("accepts a full voice object and an empty one", () => {
    const voice = { whisperBin: "/usr/local/bin/whisper-cli", model: "/m/ggml-small.bin", mode: "tap", language: "es", autoSubmit: true, threads: 4 };
    expect(AppSettingsSchema.parse({ voice }).voice).toEqual(voice);
    expect(AppSettingsSchema.parse({ voice: {} }).voice).toEqual({});
    expect(UpdateAppSettingsRequestSchema.parse({ voice: { mode: "hold" } }).voice).toEqual({ mode: "hold" });
  });

  it("rejects relative paths, unknown languages and modes", () => {
    expect(VoiceSettingsSchema.safeParse({ whisperBin: "whisper-cli" }).success).toBe(false);
    expect(VoiceSettingsSchema.safeParse({ model: "~/m.bin" }).success).toBe(false);
    expect(VoiceSettingsSchema.safeParse({ language: "spanish" }).success).toBe(false);
    expect(VoiceSettingsSchema.safeParse({ language: "auto" }).success).toBe(true);
    expect(VoiceSettingsSchema.safeParse({ mode: "toggle" }).success).toBe(false);
    expect(VoiceSettingsSchema.safeParse({ threads: 0 }).success).toBe(false);
  });
});

describe("Claude Code preferences", () => {
  it("reads voice, the legacy voiceEnabled and language leniently", () => {
    expect(readClaudeVoicePreferences({ voice: { enabled: true, mode: "tap", autoSubmit: true }, language: "spanish" })).toEqual({
      enabled: true,
      mode: "tap",
      autoSubmit: true,
      language: "spanish",
    });
    expect(readClaudeVoicePreferences({ voiceEnabled: true })).toEqual({ enabled: true });
    expect(readClaudeVoicePreferences({ voice: { mode: "push", autoSubmit: "yes" }, language: 3 })).toEqual({});
    expect(readClaudeVoicePreferences(null)).toEqual({});
    expect(readClaudeVoicePreferences([1, 2])).toEqual({});
    expect(readClaudeVoicePreferences("x")).toEqual({});
  });

  it("resolves promptgraph > Claude Code > fallback per field", () => {
    expect(resolveVoicePreferences(undefined, {})).toEqual({
      mode: "hold",
      language: "auto",
      autoSubmit: false,
      defaultsFrom: { mode: "fallback", language: "fallback", autoSubmit: "fallback" },
    });
    expect(resolveVoicePreferences({}, { mode: "tap", autoSubmit: true, language: "Español" })).toEqual({
      mode: "tap",
      language: "es",
      autoSubmit: true,
      defaultsFrom: { mode: "claude", language: "claude", autoSubmit: "claude" },
    });
    expect(resolveVoicePreferences({ mode: "hold", language: "en", autoSubmit: false }, { mode: "tap", autoSubmit: true, language: "spanish" })).toEqual({
      mode: "hold",
      language: "en",
      autoSubmit: false,
      defaultsFrom: { mode: "promptgraph", language: "promptgraph", autoSubmit: "promptgraph" },
    });
  });

  it("treats an unknown Claude Code language as absent", () => {
    const r = resolveVoicePreferences({}, { language: "klingon" });
    expect(r.language).toBe("auto");
    expect(r.defaultsFrom.language).toBe("fallback");
  });
});

describe("claudeLanguageToWhisper", () => {
  it.each([
    ["spanish", "es"],
    ["Spanish", "es"],
    ["  ENGLISH ", "en"],
    ["es", "es"],
    ["es-ES", "es"],
    ["pt_BR", "pt"],
    ["zh-Hant-TW", "zh"],
    ["español", "es"],
    ["Français", "fr"],
    ["日本語", "ja"],
    ["japanese", "ja"],
    ["haitian creole", "ht"],
    ["Spanish (Spain)", "es"],
    ["cantonese", "yue"],
    ["jv", "jw"],
    ["auto", "auto"],
  ])("%s → %s", (input, code) => {
    expect(claudeLanguageToWhisper(input)).toBe(code);
  });

  it("returns null for unknown or empty values", () => {
    expect(claudeLanguageToWhisper("klingon")).toBeNull();
    expect(claudeLanguageToWhisper("")).toBeNull();
    expect(claudeLanguageToWhisper(undefined)).toBeNull();
    expect(claudeLanguageToWhisper("xx-YY")).toBeNull();
    expect(claudeLanguageToWhisper("constructor")).toBeNull();
  });
});

describe("model auto-detection", () => {
  it("orders by family and drops VAD and non-ggml files", () => {
    expect(
      orderVoiceModelFiles([
        "ggml-medium.bin",
        "ggml-silero-v5.1.2.bin",
        "for-tests-ggml-tiny.bin",
        "ggml-tiny.bin",
        "ggml-base.en.bin",
        "ggml-small-q5_1.bin",
        "download-ggml-model.sh",
        "ggml-smaller.bin",
      ]),
    ).toEqual(["ggml-small-q5_1.bin", "ggml-base.en.bin", "ggml-medium.bin", "ggml-smaller.bin", "ggml-tiny.bin"]);
    expect(orderVoiceModelFiles(["ggml-tiny.bin", "ggml-large-v3-turbo.bin"], true)).toEqual(["ggml-large-v3-turbo.bin"]);
  });

  it("prefers ~/.promptgraph/models, then the whisper.cpp families", () => {
    const fs: Record<string, string[]> = {
      "/h/.promptgraph/models": ["ggml-tiny.bin"],
      "/h/whisper.cpp/models": ["ggml-base.bin", "ggml-small.bin"],
    };
    const listDir = (dir: string) => {
      const files = fs[dir];
      if (!files) throw new Error("ENOENT");
      return files;
    };
    const search = { promptgraphModelsDir: "/h/.promptgraph/models", whisperCppModelsDir: "/h/whisper.cpp/models/", listDir };
    expect(findVoiceModel(search)).toBe("/h/.promptgraph/models/ggml-tiny.bin");
    fs["/h/.promptgraph/models"] = [];
    expect(findVoiceModel({ ...search, whisperCppModelsDir: "/h/whisper.cpp/models" })).toBe("/h/whisper.cpp/models/ggml-small.bin");
    delete fs["/h/.promptgraph/models"];
    fs["/h/whisper.cpp/models"] = ["ggml-tiny.bin", "for-tests-ggml-base.bin"];
    expect(findVoiceModel({ ...search, whisperCppModelsDir: "/h/whisper.cpp/models" })).toBeNull();
  });
});

describe("sanitizeKeyterms", () => {
  it("trims, drops empty/long/non-string terms, dedupes and caps", () => {
    const long = "x".repeat(61);
    expect(sanitizeKeyterms([" promptgraph ", "PromptGraph", "", "a\nb\tc", long, 3, "x".repeat(60)])).toEqual(["promptgraph", "a b c", "x".repeat(60)]);
    const many = Array.from({ length: 80 }, (_, i) => `term${i}`);
    expect(sanitizeKeyterms(many)).toHaveLength(VOICE_MAX_KEYTERMS);
    expect(sanitizeKeyterms(undefined)).toEqual([]);
  });

  it("builds the whisper prompt", () => {
    expect(whisperPromptFromKeyterms(["promptgraph", "merge", " "])).toBe("promptgraph, merge");
    expect(whisperPromptFromKeyterms([])).toBeUndefined();
  });
});

describe("cleanWhisperText", () => {
  it("removes whisper artefacts and joins lines", () => {
    expect(cleanWhisperText("[BLANK_AUDIO]\n")).toBe("");
    expect(cleanWhisperText(" Add a lint step\n after the build. [Music]\n")).toBe("Add a lint step after the build.");
    expect(cleanWhisperText("(silence) hello (Music) world *laughs* ♪")).toBe("hello world");
    expect(cleanWhisperText("[ Silence ]\n[00:00:00.000 --> 00:00:02.000]  Hola mundo")).toBe("Hola mundo");
  });

  it("keeps parentheses with real words", () => {
    expect(cleanWhisperText("Remove the node (the second one).")).toBe("Remove the node (the second one).");
  });
});

describe("voice WS messages", () => {
  it("parses the client messages", () => {
    expect(ClientMessageSchema.parse({ type: "voice:start", voiceId: "v1", sampleRate: 16000, keyterms: ["promptgraph"], language: "es" })).toMatchObject({
      type: "voice:start",
    });
    expect(ClientMessageSchema.safeParse({ type: "voice:start", voiceId: "v1", sampleRate: 44100 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: "voice:start", voiceId: "", sampleRate: 16000 }).success).toBe(false);
    expect(
      ClientMessageSchema.safeParse({ type: "voice:start", voiceId: "v", sampleRate: 16000, keyterms: Array(51).fill("a") }).success,
    ).toBe(false);
    expect(ClientMessageSchema.parse({ type: "voice:stop", voiceId: "v1" }).type).toBe("voice:stop");
    expect(ClientMessageSchema.parse({ type: "voice:cancel", voiceId: "v1" }).type).toBe("voice:cancel");
  });

  it("parses the server messages", () => {
    expect(ServerMessageSchema.parse({ type: "voice:partial", voiceId: "v1", text: "hola" }).type).toBe("voice:partial");
    expect(ServerMessageSchema.parse({ type: "voice:final", voiceId: "v1", text: "hola", truncated: true })).toMatchObject({ truncated: true });
    expect(ServerMessageSchema.parse({ type: "voice:error", voiceId: "v1", code: "busy", message: "x" }).type).toBe("voice:error");
    expect(ServerMessageSchema.safeParse({ type: "voice:error", voiceId: "v1", code: "nope", message: "x" }).success).toBe(false);
  });

  it("parses a VoiceStatus", () => {
    const status = {
      available: false,
      reason: "model_not_found",
      whisperBin: "/usr/bin/whisper-cli",
      whisperBinFrom: "path",
      mode: "hold",
      language: "auto",
      autoSubmit: false,
      setup: [...VOICE_SETUP_INSTRUCTIONS],
      defaultsFrom: { mode: "fallback", language: "fallback", autoSubmit: "fallback" },
    };
    expect(VoiceStatusSchema.parse(status)).toEqual(status);
  });
});
