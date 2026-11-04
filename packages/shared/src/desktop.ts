import { z } from "zod";
import { RepoIdSchema } from "./repos.js";

/**
 * Contract between the desktop shell (Tauri, DESIGN §20) and the CLI: the shell runs
 * `promptgraph open --print-url --json` and reads the last `{"v":` JSON object of stdout as OpenUrlResult.
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

/**
 * Variables removed from the environment of the CLI started by the shell (and of a detached daemon).
 * `PG_DESKTOP_AUTO_ANSWER` and `PG_DESKTOP_UPDATES` belong to the shell process only (DESIGN §20.8, §20.10).
 */
export const DESKTOP_STRIPPED_ENV = [
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "APPDIR",
  "APPIMAGE",
  "ARGV0",
  "OWD",
  "PG_DESKTOP_AUTO_ANSWER",
  "PG_DESKTOP_UPDATES",
] as const;
/** Prefixes of variables removed likewise (AppImage / GTK / GObject introspection / WebKit runtime). */
export const DESKTOP_STRIPPED_ENV_PREFIXES = ["GTK_", "GDK_", "GIO_", "GI_", "GSETTINGS_", "WEBKIT_"] as const;
/**
 * Search-path variables an AppImage's AppRun and GTK hook prepend their mount to. The shell and the daemon
 * remove every entry inside an AppImage mount (a path segment starting with `.mount_` or
 * `appimage_extracted_`) and keep the user's own entries; a variable left empty is removed (DESIGN §20.1).
 */
export const DESKTOP_MOUNT_PATH_LISTS = [
  "PATH",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "PYTHONHOME",
  "PYTHONPATH",
  "PERLLIB",
  "QT_PLUGIN_PATH",
  "GST_PLUGIN_SYSTEM_PATH",
  "GST_PLUGIN_SYSTEM_PATH_1_0",
] as const;

// --- Distribution: bundled runtime, command shim, daemon handover (DESIGN §20.6–§20.9) ---------------

/** What `open --on-version-mismatch <policy>` does with a daemon of another version (DESIGN §4.3). */
export const VERSION_MISMATCH_POLICIES = ["auto", "restart", "attach"] as const;
export type VersionMismatchPolicy = (typeof VERSION_MISMATCH_POLICIES)[number];

/** Exit code of `open --json --on-version-mismatch auto` when the caller must decide (OpenMismatchResult on stdout). */
export const EXIT_VERSION_MISMATCH = 4;

/** Start of the stderr line `open` prints before it stops a daemon of another version; the shell shows it on the splash. */
export const DAEMON_RESTART_PROGRESS_PREFIX = "promptgraph: restarting the daemon";

/** The one stdout line of `open --json --on-version-mismatch` when it exits EXIT_VERSION_MISMATCH. */
export const OpenMismatchResultSchema = z.object({
  v: z.literal(1),
  mismatch: z.object({
    /** The running daemon's version (from its verified hello). */
    serverVersion: z.string(),
    /** This CLI's version. */
    cliVersion: z.string(),
    /** Sum of RepoSummary.runs.running over every repository; null when the daemon could not be asked. */
    runningRuns: z.number().int().nonnegative().nullable(),
    /** compareVersions(serverVersion, cliVersion) < 0. */
    daemonIsOlder: z.boolean(),
  }),
});
export type OpenMismatchResult = z.infer<typeof OpenMismatchResultSchema>;

/** `runtime/manifest.json` of a bundled runtime (DESIGN §20.6), written last by prepare-runtime.mjs. */
export const RuntimeManifestSchema = z.object({
  v: z.literal(1),
  version: z.string().min(1),
  nodeVersion: z.string().min(1),
  platform: z.literal("linux-x64"),
  /** SHA-256 over every other file of the runtime (path, mode, content). */
  buildId: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>;

/** Second line of the `~/.local/bin/promptgraph` shim: only files carrying it are ever rewritten or removed (DESIGN §20.8). */
export const SHIM_MARKER = "# promptgraph-desktop shim v1";

export const ShimDecisionSchema = z.enum(["accepted", "declined"]);
export type ShimDecision = z.infer<typeof ShimDecisionSchema>;

/** State of `~/.local/bin/promptgraph` and of the user's decision (DESIGN §20.8). */
export const ShimStatusSchema = z.object({
  path: z.string(),
  /** absent; ours (a regular file with the marker line); foreign (anything else). */
  state: z.enum(["absent", "ours", "foreign"]),
  /** realpath of a foreign entry (its link target when that does not resolve); null otherwise. */
  foreignTarget: z.string().nullable(),
  decision: ShimDecisionSchema.nullable(),
  /** Some PATH entry of the login shell is ~/.local/bin; null unless a PATH check ran (and succeeded). */
  onPath: z.boolean().nullable(),
  /** A `promptgraph` earlier on PATH than the shim; null when none, or when no PATH check ran. */
  shadowedBy: z.string().nullable(),
  /** Command that puts ~/.local/bin first on PATH for the user's shell; null unless a check ran and was not OK. */
  pathHint: z.string().nullable(),
  /** A check ran, it was not OK, and this version has not warned yet (the CLI records warnedVersion when true). */
  warn: z.boolean(),
});
export type ShimStatus = z.infer<typeof ShimStatusSchema>;

/** The one stdout line of `promptgraph desktop install --json` (DESIGN §20.7). */
export const DesktopInstallResultSchema = z.object({
  v: z.literal(1),
  version: z.string(),
  /** The versioned directory `<data>/runtime/<version>-<buildId[:8]>`. */
  root: z.string(),
  /** `<root>/bin/promptgraph`: the launcher the shell runs (never through `current`). */
  cliPath: z.string(),
  /** Name `current` points at after the call, or null. */
  current: z.string().nullable(),
  /** This call copied the build (false: it was already installed). */
  installed: z.boolean(),
  /** Directory names removed by pruning. */
  pruned: z.array(z.string()),
  shim: ShimStatusSchema,
});
export type DesktopInstallResult = z.infer<typeof DesktopInstallResultSchema>;

/** The one stdout line of `promptgraph desktop shim <action> --json`. */
export const ShimResultSchema = z.object({
  v: z.literal(1),
  shim: ShimStatusSchema,
  /** Where `install --replace` kept the previous entry. */
  backup: z.string().nullable(),
});
export type ShimResult = z.infer<typeof ShimResultSchema>;

/** `${XDG_CONFIG_HOME:-~/.config}/promptgraph/desktop.json` (mode 0600); unknown keys survive a rewrite. */
export const DesktopPrefsSchema = z.looseObject({
  v: z.literal(1),
  shim: z
    .object({
      decision: ShimDecisionSchema,
      decidedAt: z.number(),
      /** The last PATH check after an install found ~/.local/bin on PATH and not shadowed. */
      pathOk: z.boolean().optional(),
      /** Version that last showed the PATH warning (at most once per version). */
      warnedVersion: z.string().optional(),
    })
    .optional(),
});
export type DesktopPrefs = z.infer<typeof DesktopPrefsSchema>;

/** Native questions of the shell: id → button keys (DESIGN §20.8 testing aid, `PG_DESKTOP_AUTO_ANSWER`). */
export const DESKTOP_DIALOGS = {
  "shim-offer": ["install", "skip"],
  "shim-replace": ["keep", "replace"],
  "path-warning": ["ok"],
  "shim-failed": ["ok"],
  "version-mismatch": ["restart", "keep", "use"],
  update: ["update", "later"],
  "update-failed": ["ok"],
  "restart-failed": ["ok"],
} as const;

/** Arguments of the runtime installer the shell runs from the bundled runtime (DESIGN §20.7). */
export const DESKTOP_INSTALL_ARGS = ["desktop", "install", "--json"] as const;

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(v: string): ParsedVersion | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ? m[4].split(".") : [] };
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Orders two versions: numeric major.minor.patch, then a pre-release sorts before its release (semver
 * precedence; build metadata ignored). Returns -1, 0 or 1. Versions that do not parse compare as strings,
 * after every parsable one.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) {
    if (x || y) return x ? -1 : 1;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  for (let i = 0; i < 3; i++) {
    const d = x.core[i]! - y.core[i]!;
    if (d !== 0) return Math.sign(d);
  }
  return comparePre(x.pre, y.pre);
}
