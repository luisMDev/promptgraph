import type { PgPaths } from "../../config/paths.js";

/** Copies assets/pg-hook to `<binDir>/pg-hook` (mode 0755) if missing or different; returns its absolute path. */
export function installPgHook(paths: PgPaths): string {
  throw new Error("not implemented");
}
