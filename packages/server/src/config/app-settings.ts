import fs from "node:fs";
import path from "node:path";
import { AppSettingsSchema, UpdateAppSettingsRequestSchema, type AppSettings, type UpdateAppSettingsRequest } from "@promptgraph/shared";

/** App-wide settings persisted in PgPaths.settingsFile (JSON). Missing/invalid file → defaults. */
export class AppSettingsStore {
  constructor(readonly file: string) {}

  get(): AppSettings {
    let raw: unknown = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // Missing or unreadable file: defaults.
    }
    const parsed = AppSettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : AppSettingsSchema.parse({});
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
