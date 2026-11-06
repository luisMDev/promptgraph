import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SHIM_MARKER, type ShimResult, type ShimStatus } from "@promptgraph/shared";
import { currentUid } from "../config/instance-lock.js";
import { loginShellEnv, stripRuntimeEnv } from "../daemon/daemon-env.js";
import { desktopPaths, type DesktopPaths } from "./paths.js";
import { readPrefs, recordPathCheck, recordShimDecision } from "./prefs.js";

/** How much of an existing entry is read to look for the marker line (a foreign binary may be large). */
const MARKER_SCAN_BYTES = 64 * 1024;
const PATH_CHECK_TIMEOUT_MS = 10_000;

/** The shim refuses to publish: something else is at the path (DESIGN §20.8). Carries the re-read status. */
export class ShimExistsError extends Error {
  constructor(readonly status: ShimStatus) {
    super(`${status.path} exists and was not installed by the promptgraph desktop app${foreignSuffix(status)}`);
  }
}

/** ` (→ <target>)` when the foreign entry resolves elsewhere (a symlink); "" for a plain file at the path. */
function foreignSuffix(status: Pick<ShimStatus, "path" | "foreignTarget">): string {
  return status.foreignTarget && status.foreignTarget !== status.path ? ` (→ ${status.foreignTarget})` : "";
}

/** `~/.local/bin` is not safe to write a command into (owned by another user, or group/other-writable). */
export class ShimDirError extends Error {}

/** Single-quotes one shell word. */
function shq(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** What the shim runs: `<runtime>/current/bin/promptgraph`, never a versioned directory or the AppImage. */
export function shimTarget(paths: DesktopPaths): string {
  return path.join(paths.currentLink, "bin", "promptgraph");
}

/** The shim's exact text (DESIGN §20.8). */
export function shimScript(target: string): string {
  return [
    "#!/bin/sh",
    `${SHIM_MARKER}: written by the promptgraph desktop app, which rewrites or removes only files with this line.`,
    `t=${shq(target)}`,
    `[ -x "$t" ] || { echo "promptgraph: the desktop app's runtime is missing ($t); open the app once, or remove $0" >&2; exit 127; }`,
    'exec "$t" "$@"',
    "",
  ].join("\n");
}

/** First bytes of a regular file, or null when it cannot be read. */
function head(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MARKER_SCAN_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function hasMarker(text: string | null): boolean {
  return text !== null && text.split("\n").some((line) => line.startsWith(SHIM_MARKER));
}

interface EntryState {
  state: ShimStatus["state"];
  foreignTarget: string | null;
}

/** absent; ours = lstat shows a regular file with a line starting with SHIM_MARKER; foreign = anything else. */
function entryState(file: string): EntryState {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", foreignTarget: null };
    throw err;
  }
  if (st.isFile() && hasMarker(head(file))) return { state: "ours", foreignTarget: null };
  let target: string;
  try {
    target = fs.realpathSync(file);
  } catch {
    // A dangling symlink: its target as written, made absolute.
    target = st.isSymbolicLink() ? path.resolve(path.dirname(file), fs.readlinkSync(file)) : file;
  }
  return { state: "foreign", foreignTarget: target };
}

/** Result of the login shell's PATH check; all null when the check failed. */
export interface PathCheck {
  onPath: boolean | null;
  shadowedBy: string | null;
  pathHint: string | null;
}

export interface PathCheckOptions {
  timeoutMs?: number;
  /** Node binary the login shell runs to print its environment (default process.execPath). */
  node?: string;
}

const EXPORT_LINE = `'export PATH="$HOME/.local/bin:$PATH"'`;
const UBUNTU_NOTE = "(On Ubuntu, ~/.profile already adds ~/.local/bin when it exists at login: logging out and in again may be enough.)";

/**
 * The command that puts `~/.local/bin` first on PATH for `shell` (a name or a path; DESIGN §20.8): the
 * file the login shell reads, which is what the PATH check uses.
 */
export function pathHintFor(shell: string, home: string): string {
  const name = path.basename(shell);
  if (name === "zsh") return `echo ${EXPORT_LINE} >> ~/.zshrc`;
  if (name === "fish") return "fish_add_path ~/.local/bin";
  if (name === "bash") {
    if (fs.existsSync(path.join(home, ".bash_profile"))) {
      return `echo ${EXPORT_LINE} >> ~/.bash_profile\n(and add the same line to ~/.bashrc for terminals that are not login shells)`;
    }
    return `echo ${EXPORT_LINE} >> ~/.profile\n(and add the same line to ~/.bashrc for terminals that are not login shells)\n${UBUNTU_NOTE}`;
  }
  return `echo ${EXPORT_LINE} >> ~/.profile\n${UBUNTU_NOTE}`;
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the login shell's PATH (loginShellEnv, 10 s) and reports whether `~/.local/bin` is on it
 * (some entry's realpath is its realpath), a `promptgraph` that comes before it (and is not the shim),
 * and the hint for the user's shell. All fields null when the login shell cannot be asked.
 */
export async function pathCheck(env: NodeJS.ProcessEnv, opts: PathCheckOptions = {}): Promise<PathCheck> {
  const paths = desktopPaths(env);
  const base = stripRuntimeEnv(env);
  const shellEnv = await loginShellEnv(base, { node: opts.node ?? process.execPath, timeoutMs: opts.timeoutMs ?? PATH_CHECK_TIMEOUT_MS });
  if (!shellEnv || typeof shellEnv.PATH !== "string") return { onPath: null, shadowedBy: null, pathHint: null };
  const binReal = realOr(paths.binDir);
  const shimReal = realOr(paths.shimPath);
  const entries = shellEnv.PATH.split(":").filter(Boolean);
  const onPath = entries.some((e) => path.isAbsolute(e) && realOr(e) === binReal);
  let shadowedBy: string | null = null;
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) continue;
    if (realOr(entry) === binReal) break;
    const candidate = path.join(entry, "promptgraph");
    if (isExecutableFile(candidate) && realOr(candidate) !== shimReal) {
      shadowedBy = candidate;
      break;
    }
  }
  const ok = onPath && shadowedBy === null;
  return { onPath, shadowedBy, pathHint: ok ? null : pathHintFor(env.SHELL ?? "sh", paths.home) };
}

export interface ShimStatusOptions {
  /** Run the PATH check (and record its outcome; `version` is then required for `warn`). */
  checkPath?: boolean;
  /** This CLI's version: the PATH warning is shown at most once per version. */
  version?: string;
  /** Injected PATH check (tests); default pathCheck. */
  pathCheck?: (env: NodeJS.ProcessEnv) => Promise<PathCheck>;
}

/** The status without a PATH check. */
function localStatus(env: NodeJS.ProcessEnv): ShimStatus {
  const paths = desktopPaths(env);
  const entry = entryState(paths.shimPath);
  return {
    path: paths.shimPath,
    ...entry,
    decision: readPrefs(paths.prefsFile).shim?.decision ?? null,
    onPath: null,
    shadowedBy: null,
    pathHint: null,
    warn: false,
  };
}

/**
 * Runs the PATH check and records it: `pathOk`, and `warnedVersion` when this version warns (warn =
 * not OK and this version has not warned yet).
 */
async function checkAndRecord(env: NodeJS.ProcessEnv, opts: ShimStatusOptions): Promise<Pick<ShimStatus, "onPath" | "shadowedBy" | "pathHint" | "warn">> {
  const check = await (opts.pathCheck ?? ((e: NodeJS.ProcessEnv) => pathCheck(e)))(env);
  if (check.onPath === null) return { onPath: null, shadowedBy: null, pathHint: null, warn: false };
  const ok = check.onPath && check.shadowedBy === null;
  const prefs = readPrefs(desktopPaths(env).prefsFile);
  const warn = !ok && opts.version !== undefined && prefs.shim?.warnedVersion !== opts.version;
  recordPathCheck(env, ok, warn ? opts.version : undefined);
  return { ...check, pathHint: ok ? null : check.pathHint, warn };
}

/** `ShimStatus` of `~/.local/bin/promptgraph` and the recorded decision (DESIGN §20.8). */
export async function shimStatus(env: NodeJS.ProcessEnv, opts: ShimStatusOptions = {}): Promise<ShimStatus> {
  const status = localStatus(env);
  if (!opts.checkPath) return status;
  return { ...status, ...(await checkAndRecord(env, opts)), decision: readPrefs(desktopPaths(env).prefsFile).shim?.decision ?? null };
}

/** Lines of a colon-separated database such as /etc/group, split into fields; [] when unreadable. */
function readDb(file: string): string[][] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split(":"));
  } catch {
    return [];
  }
}

/**
 * Whether `gid` is the user's private group (the USERGROUPS convention of Debian/Ubuntu, where login
 * sessions get umask 002): the user's primary group, named like the user, with no listed members, and
 * the primary group of no other account in /etc/passwd. Groups only known to NSS (LDAP, sssd) are not
 * private by this test.
 */
export function isPrivateGroup(gid: number, uid: number = currentUid(), files: { group?: string; passwd?: string } = {}): boolean {
  const passwd = readDb(files.passwd ?? "/etc/passwd");
  const me = passwd.find((f) => Number(f[2]) === uid);
  if (!me || Number(me[3]) !== gid) return false;
  if (passwd.some((f) => Number(f[3]) === gid && Number(f[2]) !== uid)) return false;
  const group = readDb(files.group ?? "/etc/group").find((f) => Number(f[2]) === gid);
  return group !== undefined && group[0] === me[0] && (group[3] ?? "").trim() === "";
}

/**
 * `~/.local/bin` must be safe to publish a command into: created 0755 when missing; an existing one
 * owned by another uid, writable by others, or writable by a group that is not the user's private group
 * (DESIGN §20.8) is refused, with the `chmod` that fixes it.
 */
export function checkBinDir(binDir: string, uid: number = currentUid(), privateGroup: (gid: number) => boolean = (gid) => isPrivateGroup(gid, uid)): void {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const st = fs.statSync(binDir);
  if (!st.isDirectory()) throw new ShimDirError(`${binDir} is not a directory`);
  if (st.uid !== uid) throw new ShimDirError(`${binDir} belongs to another user (uid ${st.uid}); not installing the promptgraph command there`);
  const mode = (st.mode & 0o777).toString(8);
  if (st.mode & 0o002) throw new ShimDirError(`${binDir} is writable by other users (mode ${mode}); run \`chmod o-w ${binDir}\` and try again`);
  if (st.mode & 0o020 && !privateGroup(st.gid)) {
    throw new ShimDirError(`${binDir} is writable by its group (gid ${st.gid}, mode ${mode}); run \`chmod g-w ${binDir}\` and try again`);
  }
}

/**
 * Keeps the entry at `source` (default `target`) under the first free name `<target>.bak`, `.bak.1`, `.bak.2`… without ever
 * overwriting one (link / symlink fail with EEXIST on a taken name). A symlink is recreated with the same
 * target; anything else is hard-linked.
 */
function backupEntry(target: string, source: string = target): string {
  const st = fs.lstatSync(source);
  const link = st.isSymbolicLink() ? fs.readlinkSync(source) : null;
  for (let n = 0; n < 1000; n++) {
    const name = n === 0 ? `${target}.bak` : `${target}.bak.${n}`;
    try {
      if (link !== null) fs.symlinkSync(link, name);
      else fs.linkSync(source, name);
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`no free backup name for ${target}`);
}

interface PublishOptions {
  replace: boolean;
  uid?: number;
  /** Test seam: runs after the status was read and the temporary file written, right before publishing. */
  beforePublish?: () => void;
}

/**
 * Writes the shim without a check-then-act window (DESIGN §20.8): a temporary file 0755 in the bin dir,
 * then `link` when the path was absent (EEXIST: something appeared, reported as foreign), `rename` over
 * our own shim after re-checking its marker, or, with `replace`, over a foreign entry once it is backed
 * up. Returns the backup path. @throws ShimExistsError when a foreign entry is in the way.
 */
function publishShim(env: NodeJS.ProcessEnv, opts: PublishOptions): { backup: string | null } {
  const paths = desktopPaths(env);
  checkBinDir(paths.binDir, opts.uid);
  const script = shimScript(shimTarget(paths));
  const before = entryState(paths.shimPath);
  if (before.state === "ours" && head(paths.shimPath) === script) return { backup: null };
  if (before.state === "foreign" && !opts.replace) throw new ShimExistsError(localStatus(env));
  const tmp = path.join(paths.binDir, `.promptgraph.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, script, { flag: "wx", mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    opts.beforePublish?.();
    if (before.state === "absent") {
      try {
        fs.linkSync(tmp, paths.shimPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const now = localStatus(env);
        // Another app instance published the same shim meanwhile: nothing to do.
        if (now.state === "ours") return { backup: null };
        throw new ShimExistsError(now);
      }
      return { backup: null };
    }
    if (before.state === "ours") {
      // Re-read right before the rename: never replace a file that lost the marker meanwhile.
      if (entryState(paths.shimPath).state !== "ours") throw new ShimExistsError(localStatus(env));
      fs.renameSync(tmp, paths.shimPath);
      return { backup: null };
    }
    const backup = backupEntry(paths.shimPath);
    fs.renameSync(tmp, paths.shimPath);
    return { backup };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export interface InstallShimOptions extends Omit<ShimStatusOptions, "checkPath"> {
  replace: boolean;
  version: string;
  now?: number;
  uid?: number;
  beforePublish?: () => void;
}

/**
 * `desktop shim install [--replace]`: publishes the shim, records `accepted`, runs the PATH check and
 * records its outcome (DESIGN §20.8). @throws ShimExistsError, ShimDirError.
 */
export async function installShim(env: NodeJS.ProcessEnv, opts: InstallShimOptions): Promise<ShimResult> {
  const { backup } = publishShim(env, { replace: opts.replace, uid: opts.uid, beforePublish: opts.beforePublish });
  recordShimDecision(env, "accepted", opts.now);
  return { v: 1, shim: await shimStatus(env, { ...opts, checkPath: true }), backup };
}

/** `desktop shim decline`: records `declined` and touches no file. */
export async function declineShim(env: NodeJS.ProcessEnv, now?: number): Promise<ShimResult> {
  recordShimDecision(env, "declined", now);
  return { v: 1, shim: localStatus(env), backup: null };
}

/**
 * Removes the shim without a check-then-act window: the entry is renamed aside in the bin dir, the moved
 * file is checked for the marker, and only then unlinked; an entry that turns out not to be ours is moved
 * back (or, if something took its place meanwhile, kept as a backup and never deleted).
 */
function removeOurShim(paths: DesktopPaths): void {
  const aside = path.join(paths.binDir, `.promptgraph.${process.pid}.${randomBytes(6).toString("hex")}.rm`);
  try {
    fs.renameSync(paths.shimPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (entryState(aside).state === "ours") {
    fs.unlinkSync(aside);
    return;
  }
  try {
    // link fails with EEXIST instead of overwriting an entry that appeared at the target meanwhile.
    fs.linkSync(aside, paths.shimPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Something took the path meanwhile: keep the moved entry as a backup, never delete it.
      backupEntry(paths.shimPath, aside);
    } else if (lstatOrNull(paths.shimPath) === null) {
      // Not hard-linkable (a directory): rename it back while the path is still free.
      fs.renameSync(aside, paths.shimPath);
      return;
    } else {
      throw err;
    }
  }
  fs.unlinkSync(aside);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** `desktop shim uninstall`: removes the shim only when it carries the marker, and records `declined`. */
export async function uninstallShim(env: NodeJS.ProcessEnv, now?: number): Promise<ShimResult> {
  const paths = desktopPaths(env);
  if (entryState(paths.shimPath).state === "ours") removeOurShim(paths);
  recordShimDecision(env, "declined", now);
  return { v: 1, shim: localStatus(env), backup: null };
}

/**
 * The shim part of `desktop install` (DESIGN §20.7, §20.8): an `ours` shim without a recorded decision is
 * recorded as accepted; an `ours` shim whose text differs from what this version writes is rewritten
 * (errors leave it as it is); while the decision is accepted and the last PATH check was not OK, the
 * PATH is checked again.
 */
export async function refreshShim(env: NodeJS.ProcessEnv, opts: ShimStatusOptions & { version: string; now?: number; uid?: number }): Promise<ShimStatus> {
  const paths = desktopPaths(env);
  const entry = entryState(paths.shimPath);
  if (entry.state === "ours") {
    if (!readPrefs(paths.prefsFile).shim) recordShimDecision(env, "accepted", opts.now);
    try {
      publishShim(env, { replace: false, uid: opts.uid });
    } catch {
      // An unsafe bin dir or a race: the existing shim keeps working through `current`.
    }
  }
  const prefs = readPrefs(paths.prefsFile);
  const recheck = prefs.shim?.decision === "accepted" && prefs.shim.pathOk === false;
  return shimStatus(env, { ...opts, checkPath: recheck });
}
