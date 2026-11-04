import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RuntimeManifestSchema, type DesktopInstallResult, type RuntimeManifest } from "@promptgraph/shared";
import { currentUid, namedLockName, withSocketLock } from "../config/instance-lock.js";
import { stripRuntimeEnv } from "../daemon/daemon-env.js";
import { isProcessAlive } from "../util/process.js";
import { errorMessage, tailLines } from "../util/text.js";
import { desktopPaths, type DesktopPaths } from "./paths.js";
import { refreshShim, type ShimStatusOptions } from "./shim.js";

const MANIFEST = "manifest.json";
/** How long an install waits for another app instance holding the runtime lock. */
const LOCK_TIMEOUT_MS = 60_000;
const SELF_CHECK_TIMEOUT_MS = 15_000;
/** `<version>-<buildId[:8]>`: an installed build. */
const BUILD_DIR = /^.+-[0-9a-f]{8}$/;
const STAGING_DIR = /^\.staging-[0-9a-f]{8}-(\d+)$/;
const CURRENT_TMP = /^\.current-(\d+)$/;

/** The directories `checkRuntimeDirs`, the lock and `current` work on. */
type RuntimeDirs = Pick<DesktopPaths, "dataDir" | "runtimeDir" | "currentLink">;

/** The data or runtime directory is not safe to install into (DESIGN §20.7). */
export class RuntimeDirError extends Error {}

/** Thrown when the CLI that runs is not a bundled desktop runtime. */
export class NotARuntimeError extends Error {
  constructor(from: string) {
    super(`this promptgraph is not a bundled desktop runtime (no valid ${path.join(from, MANIFEST)})`);
  }
}

/** The processes pruning must not pull a directory from under (default: /proc). */
export interface ProcReader {
  pids(): number[];
  /** Resolved executable of `pid`, or null when unreadable (another user's process, gone). */
  exe(pid: number): string | null;
  alive(pid: number): boolean;
}

export const procReader: ProcReader = {
  pids: () => {
    try {
      return fs
        .readdirSync("/proc")
        .filter((n) => /^\d+$/.test(n))
        .map(Number);
    } catch {
      return [];
    }
  },
  exe: (pid) => {
    try {
      return fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
    } catch {
      return null;
    }
  },
  alive: isProcessAlive,
};

/** The manifest of a runtime directory, or null when missing or invalid. */
export function readManifest(dir: string): RuntimeManifest | null {
  try {
    const parsed = RuntimeManifestSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `<version>-<buildId[:8]>` */
export function buildDirName(manifest: RuntimeManifest): string {
  return `${manifest.version}-${manifest.buildId.slice(0, 8)}`;
}

/**
 * Removes an entry without following it: a symlink (dangling or not) is unlinked, a directory removed
 * recursively. Missing is fine. (`fs.rmSync` follows a symlink to a directory and skips dangling ones.)
 */
export function removeEntry(p: string): void {
  const st = lstatOrNull(p);
  if (!st) return;
  if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  else fs.unlinkSync(p);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Before anything is written (DESIGN §20.7): `<data>` and `<data>/runtime` are created when missing;
 * a `<data>/runtime` that is a symlink, or either one owned by another uid, is refused; a mode looser
 * than 0700 on `<data>/runtime` is tightened.
 * @throws RuntimeDirError
 */
export function checkRuntimeDirs(paths: RuntimeDirs, uid: number = currentUid()): void {
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const data = fs.statSync(paths.dataDir);
  if (!data.isDirectory()) throw new RuntimeDirError(`${paths.dataDir} is not a directory`);
  if (data.uid !== uid) throw new RuntimeDirError(`${paths.dataDir} belongs to another user (uid ${data.uid})`);
  let runtime = lstatOrNull(paths.runtimeDir);
  if (!runtime) {
    fs.mkdirSync(paths.runtimeDir, { mode: 0o700 });
    runtime = fs.lstatSync(paths.runtimeDir);
  }
  if (runtime.isSymbolicLink()) throw new RuntimeDirError(`${paths.runtimeDir} is a symbolic link; refusing to install the runtime through it`);
  if (!runtime.isDirectory()) throw new RuntimeDirError(`${paths.runtimeDir} is not a directory`);
  if (runtime.uid !== uid) throw new RuntimeDirError(`${paths.runtimeDir} belongs to another user (uid ${runtime.uid})`);
  if (runtime.mode & 0o077) fs.chmodSync(paths.runtimeDir, 0o700);
}

function runtimeLock<T>(paths: RuntimeDirs, fn: () => Promise<T> | T): Promise<T> {
  return withSocketLock(namedLockName("runtime", paths.runtimeDir), { timeoutMs: LOCK_TIMEOUT_MS, what: "the promptgraph runtime lock" }, fn);
}

/** Name `current` points at when it resolves to a build directory with a valid manifest; else null. */
function validCurrent(paths: RuntimeDirs): string | null {
  try {
    const link = fs.readlinkSync(paths.currentLink);
    if (link.includes("/") || !BUILD_DIR.test(link)) return null;
    const dir = path.join(paths.runtimeDir, link);
    const manifest = readManifest(dir);
    return manifest && buildDirName(manifest) === link && fs.statSync(dir).isDirectory() ? link : null;
  } catch {
    return null;
  }
}

/** Points `current` at `name` atomically: a relative symlink `.current-<pid>` renamed over it. */
function switchCurrent(paths: RuntimeDirs, name: string): void {
  const tmp = path.join(paths.runtimeDir, `.current-${process.pid}`);
  removeEntry(tmp);
  fs.symlinkSync(name, tmp);
  try {
    fs.renameSync(tmp, paths.currentLink);
  } finally {
    removeEntry(tmp);
  }
}

/**
 * Default self-check: the staged Node loads both native modules from the staged server (DESIGN §20.6
 * smoke test), so a build whose modules do not match its Node ABI never becomes installable.
 */
export function nativeSelfCheck(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const node = path.join(dir, "node", "bin", "node");
  return new Promise((resolve, reject) => {
    const child = spawn(node, ["-e", "require('better-sqlite3');require('node-pty')"], {
      cwd: path.join(dir, "server"),
      env: stripRuntimeEnv(env),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), SELF_CHECK_TIMEOUT_MS);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`the bundled Node could not load its native modules (${signal ?? `exit ${code}`}): ${tailLines(stderr.trim(), 5)}`));
    });
  });
}

/** Whether a process of the user runs an executable inside `dir`. */
function inUse(dir: string, proc: ProcReader): boolean {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = dir;
  }
  return proc.pids().some((pid) => {
    const exe = proc.exe(pid);
    return exe !== null && (exe === real || exe.startsWith(`${real}/`));
  });
}

/**
 * Best-effort removal for pruning: an entry that cannot be removed (EACCES on a read-only subdirectory,
 * EBUSY) is left for the next start and reported on stderr, never failing the install.
 */
function tryRemove(p: string): boolean {
  try {
    removeEntry(p);
    return true;
  } catch (err) {
    process.stderr.write(`promptgraph: could not remove ${p}, leaving it for the next start: ${errorMessage(err)}\n`);
    return false;
  }
}

/**
 * Refuses a symlink in the bundled runtime: `fs.cpSync` rewrites a relative link as an absolute path
 * into the source, which for an AppImage is a FUSE mount that disappears when the app exits (DESIGN
 * §20.6 keeps the stage free of symlinks; this is the installer's own check).
 */
function refuseSymlink(root: string, src: string): void {
  if (fs.lstatSync(src).isSymbolicLink()) throw new Error(`the bundled runtime contains a symlink: ${path.relative(root, src)}`);
}

/**
 * Removes (DESIGN §20.7) `.staging-*` and `.current-*` leftovers of dead processes, and every build
 * directory that is not in `keep` (current's target and the build just installed) and that no live
 * process runs from. Returns the names removed (temporary `.current-*` links are not reported).
 */
export function pruneRuntimes(runtimeDir: string, opts: { keep: readonly (string | null)[]; proc?: ProcReader }): string[] {
  const proc = opts.proc ?? procReader;
  const keep = new Set(opts.keep.filter((k): k is string => k !== null));
  const pruned: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(runtimeDir);
  } catch {
    return pruned;
  }
  for (const name of names.sort()) {
    const full = path.join(runtimeDir, name);
    const staging = STAGING_DIR.exec(name);
    const currentTmp = CURRENT_TMP.exec(name);
    if (staging || currentTmp) {
      const pid = Number((staging ?? currentTmp)![1]);
      if (pid === process.pid || proc.alive(pid)) continue;
      if (tryRemove(full) && staging) pruned.push(name);
      continue;
    }
    if (name === "current" || keep.has(name) || !BUILD_DIR.test(name)) continue;
    const st = lstatOrNull(full);
    if (!st || !st.isDirectory() || inUse(full, proc)) continue;
    if (tryRemove(full)) pruned.push(name);
  }
  return pruned;
}

export interface InstallRuntimeOptions {
  /** The bundled runtime (`SERVER_PACKAGE_DIR/..`), holding manifest.json. */
  from: string;
  env: NodeJS.ProcessEnv;
  now?: number;
  proc?: ProcReader;
  /** Loads the native modules with the staged Node (default nativeSelfCheck). */
  selfCheck?: (stagingDir: string) => Promise<void>;
  uid?: number;
  /** Injected PATH check of the shim status (tests). */
  pathCheck?: ShimStatusOptions["pathCheck"];
}

/**
 * `promptgraph desktop install` (DESIGN §20.7): makes sure the bundled build exists as a complete
 * versioned directory `<data>/runtime/<version>-<id8>` (copy into `.staging-<id8>-<pid>`, self-check
 * with the staged Node, manifest last, rename), sets `current` **only** when it is missing or broken
 * (otherwise `open --on-version-mismatch` moves it, once its daemon runs), prunes, and reports the shim.
 * Everything that writes runs under the runtime lock.
 * @throws NotARuntimeError, RuntimeDirError, or the self-check / copy error.
 */
export async function installRuntime(opts: InstallRuntimeOptions): Promise<DesktopInstallResult> {
  const from = path.resolve(opts.from);
  const manifest = readManifest(from);
  if (!manifest) throw new NotARuntimeError(from);
  const paths = desktopPaths(opts.env);
  checkRuntimeDirs(paths, opts.uid);
  const name = buildDirName(manifest);
  const target = path.join(paths.runtimeDir, name);
  const selfCheck = opts.selfCheck ?? ((dir: string) => nativeSelfCheck(dir, opts.env));

  const { installed, current, pruned } = await runtimeLock(paths, async () => {
    let installed = false;
    if (readManifest(target)?.buildId !== manifest.buildId) {
      const staging = path.join(paths.runtimeDir, `.staging-${manifest.buildId.slice(0, 8)}-${process.pid}`);
      removeEntry(staging);
      try {
        const manifestFile = path.join(from, MANIFEST);
        fs.cpSync(from, staging, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
          filter: (src) => {
            const abs = path.resolve(src);
            if (abs !== from) refuseSymlink(from, abs);
            return abs !== manifestFile;
          },
        });
        try {
          await selfCheck(staging);
        } catch (err) {
          throw new Error(`the bundled runtime ${name} failed its self-check: ${errorMessage(err)}`);
        }
        fs.copyFileSync(path.join(from, MANIFEST), path.join(staging, MANIFEST));
        // A leftover target without a valid manifest (an interrupted install, a manual edit) goes first.
        if (lstatOrNull(target) && readManifest(target)?.buildId !== manifest.buildId) removeEntry(target);
        try {
          fs.renameSync(staging, target);
          installed = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if ((code !== "EEXIST" && code !== "ENOTEMPTY") || readManifest(target)?.buildId !== manifest.buildId) throw err;
        }
      } finally {
        // A failed cleanup must not replace the self-check or copy error; the next prune retries it.
        tryRemove(staging);
      }
    }
    let current = validCurrent(paths);
    if (current === null) {
      switchCurrent(paths, name);
      current = name;
    }
    const pruned = pruneRuntimes(paths.runtimeDir, { keep: [current, name], proc: opts.proc });
    return { installed, current, pruned };
  });

  const shim = await refreshShim(opts.env, { version: manifest.version, now: opts.now, uid: opts.uid, pathCheck: opts.pathCheck });
  return {
    v: 1,
    version: manifest.version,
    root: target,
    cliPath: path.join(target, "bin", "promptgraph"),
    current,
    installed,
    pruned,
    shim,
  };
}

/**
 * The runtime directory `root` is installed in, from `root`'s own location (DESIGN §4.3 "Runtime
 * activation"), never from the environment: `desktop install` runs with the app's environment and `open`
 * through the login shell, whose start-up files may export another `XDG_DATA_HOME`. `root` must resolve
 * to `<runtime>/<version>-<id8>` with a valid manifest of that name, in a real directory named `runtime`
 * that belongs to `uid`, is not group- or world-writable, and already holds `current`. Never throws.
 */
export function installedRuntimeOf(root: string, uid: number = currentUid()): { name: string; dirs: RuntimeDirs } | null {
  try {
    const manifest = readManifest(root);
    if (!manifest) return null;
    const real = fs.realpathSync(root);
    const name = path.basename(real);
    const runtimeDir = path.dirname(real);
    if (name !== buildDirName(manifest) || path.basename(runtimeDir) !== "runtime") return null;
    const st = fs.lstatSync(runtimeDir);
    if (!st.isDirectory() || st.uid !== uid || st.mode & 0o022) return null;
    const currentLink = path.join(runtimeDir, "current");
    if (!fs.lstatSync(currentLink).isSymbolicLink()) return null;
    return { name, dirs: { dataDir: path.dirname(runtimeDir), runtimeDir, currentLink } };
  } catch {
    return null;
  }
}

/** Whether `root` is an installed build (installedRuntimeOf). Never throws. */
export function isInstalledRuntime(root: string, uid?: number): boolean {
  return installedRuntimeOf(root, uid) !== null;
}

/**
 * Switches `current` of the runtime directory `root` is installed in to `root` (DESIGN §4.3 "Runtime
 * activation"), under the runtime lock, atomically. @throws when `root` is not an installed build, or the
 * runtime directory is unsafe.
 */
export async function activateRuntime(root: string, opts: { uid?: number } = {}): Promise<{ switched: boolean; current: string }> {
  const installed = installedRuntimeOf(root, opts.uid);
  if (!installed) throw new Error(`${root} is not an installed promptgraph runtime`);
  const { name, dirs } = installed;
  checkRuntimeDirs(dirs, opts.uid);
  return runtimeLock(dirs, () => {
    let link: string | null = null;
    try {
      link = fs.readlinkSync(dirs.currentLink);
    } catch {
      // Missing (or not a link): switched below.
    }
    if (link === name) return { switched: false, current: name };
    switchCurrent(dirs, name);
    return { switched: true, current: name };
  });
}
