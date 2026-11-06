import fs from "node:fs";
import path from "node:path";
import {
  AppSettingsSchema,
  UpdateAppSettingsRequestSchema,
  VoiceSettingsSchema,
  type AppSettings,
  type UpdateAppSettingsRequest,
  type VoiceSettings,
} from "@promptgraph/shared";

/**
 * Lenient read of a stored settings object: each top-level key, and each `voice` field, is validated on its own
 * and only the invalid ones fall back to their default. A hand-edited typo (e.g. `voice.language: "es-ES"` or a
 * `~/…` path) must not reset every other setting, which the next PUT would then write over the file.
 */
export function parseStoredAppSettings(raw: unknown): AppSettings {
  const whole = AppSettingsSchema.safeParse(raw);
  if (whole.success) return whole.data;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const shape = AppSettingsSchema.shape;
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    if (!(key in obj)) continue;
    if (key === "voice") {
      const voice = parseStoredVoiceSettings(obj.voice);
      if (voice) kept.voice = voice;
      continue;
    }
    const field = shape[key].safeParse(obj[key]);
    if (field.success) kept[key] = field.data;
  }
  return AppSettingsSchema.parse(kept);
}

function parseStoredVoiceSettings(raw: unknown): VoiceSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const shape = VoiceSettingsSchema.shape;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    if (obj[key] === undefined) continue;
    const field = shape[key].safeParse(obj[key]);
    if (field.success) out[key] = field.data;
  }
  return VoiceSettingsSchema.parse(out);
}

/** App-wide settings persisted in PgPaths.settingsFile (JSON). Missing file → defaults; invalid fields → their default. */
export class AppSettingsStore {
  constructor(readonly file: string) {}

  get(): AppSettings {
    let raw: unknown = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // Missing or unreadable file: defaults.
    }
    return parseStoredAppSettings(raw);
  }

  /**
   * Merges, validates, writes atomically, returns the new settings. Only keys present in `patch` are
   * applied: parsing a patch with UpdateAppSettingsRequestSchema would fill the defaults back in.
   */
  update(patch: UpdateAppSettingsRequest): AppSettings {
    UpdateAppSettingsRequestSchema.parse(patch);
    const present = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = AppSettingsSchema.parse({ ...this.get(), ...present });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    return next;
  }
}
