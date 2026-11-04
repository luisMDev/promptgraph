import path from "node:path";
import { isSafeNextPath, SessionIdPrefixSchema, VERSION_MISMATCH_POLICIES, type VersionMismatchPolicy } from "@promptgraph/shared";

/** Commands of the `promptgraph` bin (DESIGN §4). */
export type CliCommand =
  /** `promptgraph [repo-dir]`: detached start (or `--foreground`), register, open. */
  | "open-repo"
  /** `promptgraph daemon`: the daemon in this terminal (also what ensureDaemon spawns detached). */
  | "daemon"
  /** `promptgraph mcp`: the MCP server on stdio (§19.2). */
  | "mcp"
  | "ls"
  | "open"
  /** `rm` and its alias `close`. */
  | "rm"
  | "stop"
  /** `token rotate` */
  | "token-rotate"
  | "sessions"
  /** `sessions revoke <id>|--all` */
  | "sessions-revoke"
  /** `desktop install --json` (internal: the desktop app's runtime installer, DESIGN §20.7) */
  | "desktop-install"
  /** `desktop shim status|install|decline|uninstall --json` (internal: ~/.local/bin/promptgraph, DESIGN §20.8) */
  | "desktop-shim";

/** Actions of `desktop shim`. */
export const SHIM_ACTIONS = ["status", "install", "decline", "uninstall"] as const;
export type ShimAction = (typeof SHIM_ACTIONS)[number];

export interface CliOptions {
  command: CliCommand;
  /** open-repo: the repository directory, resolved against cwd (default cwd; the git top level is found later). */
  repoDir: string;
  /**
   * open / rm: the raw repository argument, a directory or a repoId (resolved by the command); null when
   * omitted. sessions-revoke: the session id prefix (lowercased), null with `--all`.
   */
  target: string | null;
  /** Only set when the user passed `--port`: the daemon otherwise picks its sticky / default / random port. */
  port: number | null;
  /** `--port` was given (open-repo, daemon). */
  portExplicit: boolean;
  /** open-repo: `--no-open` clears it. */
  open: boolean;
  /** open-repo: run the daemon in this process. */
  foreground: boolean;
  /** ls, sessions: machine-readable output; open: one OpenUrlResult line (implies `printUrl`). */
  json: boolean;
  /** open: print the login URL instead of opening a browser. */
  printUrl: boolean;
  /** open: target path instead of `/r/<repoId>` or Home (passes isSafeNextPath). */
  next: string | null;
  /** open: build the URL on `http://127.0.0.1:<webPort>` (the vite dev server). */
  webPort: number | null;
  /** rm: stop the repository's running runs first. */
  force: boolean;
  /** sessions-revoke: every session. */
  all: boolean;
  help: boolean;
  version: boolean;
  /** open: what to do with a daemon of another version (requires `--json`, DESIGN §4.3); null = fail as usual. */
  onVersionMismatch: VersionMismatchPolicy | null;
  /** desktop-shim: the action. */
  shimAction: ShimAction | null;
  /** desktop-shim install: replace a foreign entry (kept as a backup). */
  replace: boolean;
}

/** A command line that does not parse: the CLI prints it with USAGE and exits 2. */
export class UsageError extends Error {}

/** Subcommands, recognised only as the first argument (a repository named like one is passed as `./name`). */
const SUBCOMMANDS: Record<string, CliCommand> = {
  daemon: "daemon",
  mcp: "mcp",
  ls: "ls",
  open: "open",
  rm: "rm",
  close: "rm",
  stop: "stop",
  token: "token-rotate",
  sessions: "sessions",
  desktop: "desktop-install",
};

/** Options each command accepts (`--help` and `--version` are global). */
const ALLOWED: Record<CliCommand, ReadonlySet<string>> = {
  "open-repo": new Set(["port", "no-open", "foreground"]),
  daemon: new Set(["port"]),
  mcp: new Set(),
  ls: new Set(["json"]),
  open: new Set(["json", "print-url", "next", "web-port", "on-version-mismatch"]),
  rm: new Set(["force"]),
  stop: new Set(),
  "token-rotate": new Set(),
  sessions: new Set(["json"]),
  "sessions-revoke": new Set(["all"]),
  "desktop-install": new Set(["json"]),
  "desktop-shim": new Set(["json", "replace"]),
};

function parsePort(value: string | undefined, name: string, min = 0): number {
  const port = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isInteger(port) || port < min || port > 65535) {
    throw new UsageError(`Invalid ${name}: ${value ?? "(missing)"}`);
  }
  return port;
}

/**
 * Parses the `promptgraph` command line (DESIGN §4). Subcommands are recognised only as argv[0]
 * (`token rotate` and `sessions revoke` are two words); `close` is an alias of `rm`.
 * @throws UsageError on bad args.
 */
export function parseCliArgs(argv: readonly string[], cwd: string = process.cwd()): CliOptions {
  const opts: CliOptions = {
    command: "open-repo",
    repoDir: cwd,
    target: null,
    port: null,
    portExplicit: false,
    open: true,
    foreground: false,
    json: false,
    printUrl: false,
    next: null,
    webPort: null,
    force: false,
    all: false,
    help: false,
    version: false,
    onVersionMismatch: null,
    shimAction: null,
    replace: false,
  };
  let i = 0;
  const first = argv[0];
  if (first !== undefined && Object.hasOwn(SUBCOMMANDS, first)) {
    opts.command = SUBCOMMANDS[first]!;
    i = 1;
    if (first === "token") {
      if (argv[1] !== "rotate") throw new UsageError(argv[1] === undefined ? "token: missing action (token rotate)" : `Unknown token action: ${argv[1]}`);
      i = 2;
    } else if (first === "sessions" && argv[1] === "revoke") {
      opts.command = "sessions-revoke";
      i = 2;
    } else if (first === "desktop") {
      // Internal commands of the desktop app (hidden from USAGE).
      if (argv[1] === "install") i = 2;
      else if (argv[1] === "shim") {
        const action = argv[2];
        if (!(SHIM_ACTIONS as readonly string[]).includes(action ?? "")) {
          throw new UsageError(action === undefined ? "desktop shim: missing action (status, install, decline, uninstall)" : `Unknown desktop shim action: ${action}`);
        }
        opts.command = "desktop-shim";
        opts.shimAction = action as ShimAction;
        i = 3;
      } else throw new UsageError(argv[1] === undefined ? "desktop: missing action (install, shim)" : `Unknown desktop action: ${argv[1]}`);
    }
  }

  const positionals: string[] = [];
  const valueOf = (arg: string, name: string): string | undefined => {
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
    return argv[++i];
  };
  const allow = (name: string, arg: string) => {
    if (!ALLOWED[opts.command].has(name)) throw new UsageError(`Unknown option for ${commandName(opts.command)}: ${arg}`);
  };
  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    const name = arg.startsWith("--") ? arg.slice(2).split("=")[0]! : arg;
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version" || arg === "-v") opts.version = true;
    else if (arg === "--port" || arg === "-p" || arg.startsWith("--port=")) {
      allow("port", arg);
      opts.port = parsePort(valueOf(arg, "port"), "port");
      opts.portExplicit = true;
    } else if (arg === "--web-port" || arg.startsWith("--web-port=")) {
      allow("web-port", arg);
      opts.webPort = parsePort(valueOf(arg, "web-port"), "web port", 1);
    } else if (arg === "--on-version-mismatch" || arg.startsWith("--on-version-mismatch=")) {
      allow("on-version-mismatch", arg);
      const policy = valueOf(arg, "on-version-mismatch");
      if (!(VERSION_MISMATCH_POLICIES as readonly string[]).includes(policy ?? "")) {
        throw new UsageError(`Invalid --on-version-mismatch: ${policy ?? "(missing)"} (${VERSION_MISMATCH_POLICIES.join(", ")})`);
      }
      opts.onVersionMismatch = policy as VersionMismatchPolicy;
    } else if (arg === "--next" || arg.startsWith("--next=")) {
      allow("next", arg);
      const next = valueOf(arg, "next");
      if (!isSafeNextPath(next)) throw new UsageError(`Invalid --next: ${next ?? "(missing)"} (a path starting with a single /)`);
      opts.next = next;
    } else if (arg === "--no-open" || arg === "--foreground" || arg === "--json" || arg === "--print-url" || arg === "--force" || arg === "--all" || arg === "--replace") {
      allow(name, arg);
      if (arg === "--no-open") opts.open = false;
      else if (arg === "--foreground") opts.foreground = true;
      else if (arg === "--json") opts.json = true;
      else if (arg === "--print-url") opts.printUrl = true;
      else if (arg === "--force") opts.force = true;
      else if (arg === "--replace") opts.replace = true;
      else opts.all = true;
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }

  applyPositionals(opts, positionals, cwd);
  if (!opts.help) {
    if (opts.onVersionMismatch !== null && !opts.json) throw new UsageError("--on-version-mismatch requires --json");
    if ((opts.command === "desktop-install" || opts.command === "desktop-shim") && !opts.json) throw new UsageError(`${commandName(opts.command)} requires --json`);
    if (opts.replace && opts.shimAction !== "install") throw new UsageError("--replace is only valid with desktop shim install");
  }
  // The desktop shell's interface: one JSON line and no browser (DESIGN §4.3).
  if (opts.command === "open" && opts.json) opts.printUrl = true;
  return opts;
}

function applyPositionals(opts: CliOptions, positionals: string[], cwd: string): void {
  const max = opts.command === "open-repo" || opts.command === "open" || opts.command === "rm" || opts.command === "sessions-revoke" ? 1 : 0;
  if (positionals.length > max) throw new UsageError(`Unexpected argument: ${positionals[max]}`);
  const value = positionals[0] ?? null;
  switch (opts.command) {
    case "open-repo":
      if (value !== null) opts.repoDir = path.resolve(cwd, value);
      return;
    case "open":
      opts.target = value;
      return;
    case "rm":
      if (value === null && !opts.help) throw new UsageError("rm: missing repository (a directory or a repository id)");
      opts.target = value;
      return;
    case "sessions-revoke": {
      if (opts.help) return;
      if (opts.all === (value !== null)) throw new UsageError("sessions revoke: give one session id or --all");
      if (value !== null) {
        // The daemon's `:id` rule (shared schema); `all` is only reachable through --all.
        const id = SessionIdPrefixSchema.safeParse(value);
        if (!id.success || id.data === "all") throw new UsageError(`Invalid session id: ${value} (8 or more hex digits, see promptgraph sessions)`);
        opts.target = id.data;
      }
      return;
    }
    default:
      return;
  }
}

function commandName(command: CliCommand): string {
  if (command === "token-rotate") return "token rotate";
  if (command === "sessions-revoke") return "sessions revoke";
  if (command === "open-repo") return "promptgraph";
  if (command === "desktop-install") return "desktop install";
  if (command === "desktop-shim") return "desktop shim";
  return command;
}

export const USAGE = `Usage: promptgraph [repo-dir] [--port 4777] [--no-open] [--foreground]   register a repository and open it
       promptgraph daemon [--port 4777]                                  run the daemon in this terminal
       promptgraph ls [--json]                                           daemon status and repositories
       promptgraph open [repo-dir|repo-id] [--next <path>] [--print-url] [--json] [--web-port <p>]
                        [--on-version-mismatch auto|restart|attach]      open the UI, signed in
       promptgraph rm <repo-dir|repo-id> [--force]                       forget a repository (alias: close)
       promptgraph stop                                                  stop the daemon
       promptgraph token rotate                                          new token; every window signs in again
       promptgraph sessions [--json]                                     signed-in browsers and desktop windows
       promptgraph sessions revoke <id>|--all                            sign one or every session out
       promptgraph mcp                                                   MCP server on stdio, for Claude Code
A repository directory named like a command is passed as ./name.
Exit codes: 0 ok, 1 error (also "not running" and a version mismatch), 2 usage, 3 daemon lock held,
4 (open --json --on-version-mismatch auto) a daemon of another version runs and the caller must decide.`;
