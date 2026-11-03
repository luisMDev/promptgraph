import path from "node:path";

export interface CliOptions {
  /**
   * "open-repo" (default, `promptgraph [repo-dir]`), "daemon" (`promptgraph daemon`: the daemon in this
   * terminal) or "mcp" (`promptgraph mcp`: the MCP server on stdio, §19.2).
   */
  command: "open-repo" | "daemon" | "mcp";
  /** Default cwd; resolved to the git top level later. */
  repoDir: string;
  /** Only set when the user passed `--port`: the daemon otherwise picks its sticky / default / random port. */
  port: number | null;
  open: boolean;
  /** Run the daemon in this process (`promptgraph [repo-dir] --foreground`). */
  foreground: boolean;
  help: boolean;
  version: boolean;
}

/** Subcommands, recognised only as the first argument (a repository named like one is passed as `./name`). */
const SUBCOMMANDS = { daemon: "daemon", mcp: "mcp" } as const;

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (!value || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${value ?? "(missing)"}`);
  return port;
}

/**
 * `promptgraph [repo-dir] [--port p] [--no-open] [--foreground]`, `promptgraph daemon [--port p]` or
 * `promptgraph mcp` (DESIGN §4). @throws on bad args.
 */
export function parseCliArgs(argv: readonly string[], cwd: string = process.cwd()): CliOptions {
  const opts: CliOptions = { command: "open-repo", repoDir: cwd, port: null, open: true, foreground: false, help: false, version: false };
  let repoDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--port" || arg === "-p") opts.port = parsePort(argv[++i]);
    else if (arg.startsWith("--port=")) opts.port = parsePort(arg.slice("--port=".length));
    else if (arg === "--no-open" && opts.command === "open-repo") opts.open = false;
    else if (arg === "--foreground" && opts.command === "open-repo") opts.foreground = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version" || arg === "-v") opts.version = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (i === 0 && Object.hasOwn(SUBCOMMANDS, arg)) opts.command = SUBCOMMANDS[arg as keyof typeof SUBCOMMANDS];
    else if (repoDir === null && opts.command === "open-repo") repoDir = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (opts.command === "mcp" && opts.port !== null) throw new Error("Unknown option for mcp: --port");
  if (repoDir !== null) opts.repoDir = path.resolve(cwd, repoDir);
  return opts;
}

export const USAGE = `Usage: promptgraph [repo-dir] [--port 4777] [--no-open] [--foreground]
       promptgraph daemon [--port 4777]   (the daemon in this terminal)
       promptgraph mcp                    (MCP server on stdio, for Claude Code)`;
