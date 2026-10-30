import { type AppSettings, type UpdateAppSettingsRequest } from "@promptgraph/shared";

/** App-wide settings persisted in PgPaths.settingsFile (JSON). Missing/invalid file → defaults. */
export class AppSettingsStore {
  constructor(readonly file: string) {}

  get(): AppSettings {
    throw new Error("not implemented");
  }

  /** Merges, validates, writes atomically, returns the new settings. */
  update(patch: UpdateAppSettingsRequest): AppSettings {
    throw new Error("not implemented");
  }
}
