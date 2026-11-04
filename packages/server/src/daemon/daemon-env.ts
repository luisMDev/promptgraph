import { spawn } from "node:child_process";
import { DESKTOP_STRIPPED_ENV, DESKTOP_STRIPPED_ENV_PREFIXES } from "@promptgraph/shared";
import { DESKTOP_ENV_PREFIX, isClaudeNestingVar, PG_HOOK_ENV_VARS } from "../config/child-env.js";

/** Caller variables a detached daemon keeps (DESIGN §4.1 item 5). */
const ALLOWED_EXACT = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TERM",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "WSLENV",
  // Where Claude Code keeps its config, auth, trust and transcripts: children must use the caller's.
  "CLAUDE_CONFIG_DIR",
]);
const ALLOWED_PREFIXES = ["LC_", "XDG_", "PG_"];

/** Per-process shell state that means nothing to the daemon (its cwd is PG_HOME). */
const SHELL_STATE = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

const DEFAULT_SHELL_TIMEOUT_MS = 10_000;

export interface DaemonEnvOptions {
  /** The spawner's environment (often a Claude session, a direnv shell or a desktop launcher). */
  caller: NodeJS.ProcessEnv;
  /** Merge the login shell's environment (`$SHELL -ilc`). Default true; `PG_DAEMON_SHELL_ENV=0` disables it. */
  resolveShell?: boolean;
  shellTimeoutMs?: number;
  /** Node binary that prints the environment inside the login shell. Default process.execPath. */
  node?: string;
}

function isAllowed(name: string): boolean {
  return ALLOWED_EXACT.has(name) || ALLOWED_PREFIXES.some((p) => name.startsWith(p));
}

function defined(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** XDG search-path variables an AppImage's GTK hook prepends its mount to (DESIGN §4.1 item 5). */
const XDG_DIR_LISTS = ["XDG_DATA_DIRS", "XDG_CONFIG_DIRS"] as const;

/** Whether a path lies inside an AppImage mount: some path segment starts with `.mount_`. */
function inAppImageMount(entry: string): boolean {
  return entry.split("/").some((segment) => segment.startsWith(".mount_"));
}

/**
 * Removes what a desktop runtime (AppImage, GTK, WebKit) or a Claude session injects and must not reach
 * the daemon's children: `DESKTOP_STRIPPED_ENV`, the `DESKTOP_STRIPPED_ENV_PREFIXES` (incl. `GI_`), every
 * `PG_DESKTOP_*`, the Claude nesting variables and a node run's hook variables (PG_HOOK_ENV_VARS, which
 * the `PG_` allowlist would otherwise keep). `XDG_DATA_DIRS` / `XDG_CONFIG_DIRS` lose their entries inside
 * an AppImage mount (`.mount_*`), which disappears with the app; a variable left empty is dropped.
 */
export function stripRuntimeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const stripped = new Set<string>(DESKTOP_STRIPPED_ENV);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || stripped.has(k) || PG_HOOK_ENV_VARS.has(k) || isClaudeNestingVar(k) || k.startsWith(DESKTOP_ENV_PREFIX)) continue;
    if (DESKTOP_STRIPPED_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  for (const name of XDG_DIR_LISTS) {
    const value = out[name];
    if (value === undefined) continue;
    const kept = value.split(":").filter((entry) => entry !== "" && !inAppImageMount(entry));
    if (kept.length > 0) out[name] = kept.join(":");
    else delete out[name];
  }
  return out;
}

/** Single-quotes one shell word. */
function shq(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Last stdout line that parses as a JSON object of strings (shell profiles may print noise before it). */
export function lastJsonObjectLine(stdout: string): Record<string, string> | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
      }
    } catch {
      // Not the environment line.
    }
  }
  return null;
}

/**
 * Environment of the user's login shell: `$SHELL -ilc '<node> -e "…print process.env as JSON…"'`, the
 * way editors resolve it, with stdin closed (a prompt reads EOF) and a timeout that kills the whole
 * process group. Null when there is no SHELL, the shell fails, times out or prints no JSON line.
 */
export function loginShellEnv(base: Record<string, string>, opts: { node: string; timeoutMs: number }): Promise<Record<string, string> | null> {
  const shell = base.SHELL;
  if (!shell) return Promise.resolve(null);
  const script = 'process.stdout.write("\\n" + JSON.stringify(process.env) + "\\n")';
  const command = `${shq(opts.node)} -e ${shq(script)}`;
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (value: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(shell, ["-ilc", command], { env: base, stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      done(null);
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.once("error", () => done(null));
    child.once("close", () => done(lastJsonObjectLine(stdout)));
  });
}

/**
 * Environment of a detached daemon (DESIGN §4.1 item 5): the allowlisted caller variables, merged over
 * the login shell's environment (skipped with `PG_DAEMON_SHELL_ENV=0` or `resolveShell: false`; on
 * failure or timeout the caller's `PATH` is used), then stripRuntimeEnv. The caller's allowlisted
 * variables win (they include `PG_*`, which names the PG_HOME the daemon must use).
 */
export async function daemonEnv(opts: DaemonEnvOptions): Promise<Record<string, string>> {
  const caller = defined(opts.caller);
  const allowed: Record<string, string> = {};
  for (const [k, v] of Object.entries(caller)) if (isAllowed(k)) allowed[k] = v;
  const resolveShell = (opts.resolveShell ?? true) && caller.PG_DAEMON_SHELL_ENV !== "0";
  let shellEnv: Record<string, string> | null = null;
  if (resolveShell) {
    const base = stripRuntimeEnv({ ...allowed, ...(caller.PATH ? { PATH: caller.PATH } : {}) });
    shellEnv = await loginShellEnv(base, { node: opts.node ?? process.execPath, timeoutMs: opts.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS });
  }
  const merged: Record<string, string> = {};
  if (shellEnv) {
    for (const [k, v] of Object.entries(shellEnv)) if (!SHELL_STATE.has(k)) merged[k] = v;
  } else if (caller.PATH) {
    merged.PATH = caller.PATH;
  }
  Object.assign(merged, allowed);
  return stripRuntimeEnv(merged);
}
