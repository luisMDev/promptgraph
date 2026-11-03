import { z } from "zod";
import { RepoIdSchema } from "./repos.js";

/**
 * Contract between the desktop shell (Tauri, DESIGN §20) and the CLI: the shell runs
 * `promptgraph open --print-url --json` and reads the last JSON line of stdout as OpenUrlResult.
 */
export const OPEN_URL_RESULT_VERSION = 1;

export const OpenUrlResultSchema = z.object({
  v: z.literal(OPEN_URL_RESULT_VERSION),
  /** Version of the CLI that printed it (the splash reports an incompatible CLI). */
  cliVersion: z.string(),
  /** One-time login URL on the daemon's origin. */
  url: z.string().url(),
  port: z.number().int().positive(),
  repoId: RepoIdSchema.nullable(),
});
export type OpenUrlResult = z.infer<typeof OpenUrlResultSchema>;

/** The only app command of the desktop shell; args `{ next: string }`. */
export const DESKTOP_COMMANDS = { relogin: "relogin" } as const;

/** Arguments the shell passes to the CLI. */
export const DESKTOP_OPEN_ARGS = ["open", "--print-url", "--json"] as const;

/** Permissions of the runtime capability granted to the daemon's origin (DESIGN §20.3). */
export const DESKTOP_PERMISSIONS = [
  "core:window:allow-minimize",
  "core:window:allow-toggle-maximize",
  "core:window:allow-internal-toggle-maximize",
  "core:window:allow-is-maximized",
  "core:window:allow-close",
  "core:window:allow-start-dragging",
  "core:window:allow-start-resize-dragging",
  "core:window:allow-set-title",
  /* scoped to https://* */ "opener:allow-open-url",
  "allow-relogin",
] as const;

/** Variables removed from the environment of the CLI started by the shell (and of a detached daemon). */
export const DESKTOP_STRIPPED_ENV = ["LD_LIBRARY_PATH", "LD_PRELOAD", "APPDIR", "APPIMAGE", "ARGV0", "OWD"] as const;
/** Prefixes of variables removed likewise (AppImage / GTK / WebKit runtime). */
export const DESKTOP_STRIPPED_ENV_PREFIXES = ["GTK_", "GDK_", "GIO_", "GSETTINGS_", "WEBKIT_"] as const;
