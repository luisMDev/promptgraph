import path from "node:path";

export interface CliOptions {
  /** Default cwd; resolved to the git top-level later. */
  repoDir: string;
  /** Default 4777 (`PG_PORT_DEFAULT` env overrides for tests). */
  port: number;
  open: boolean;
  help: boolean;
  version: boolean;
}

const DEFAULT_PORT = 4777;

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (!value || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${value ?? "(missing)"}`);
  return port;
}

/** `promptgraph [repo-dir] [--port 4777] [--no-open] [--help] [--version]` (§4). @throws on bad args. */
export function parseCliArgs(argv: readonly string[], cwd: string = process.cwd()): CliOptions {
  const envPort = process.env.PG_PORT_DEFAULT;
  const opts: CliOptions = { repoDir: cwd, port: envPort ? parsePort(envPort) : DEFAULT_PORT, open: true, help: false, version: false };
  let repoDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--port" || arg === "-p") opts.port = parsePort(argv[++i]);
    else if (arg.startsWith("--port=")) opts.port = parsePort(arg.slice("--port=".length));
    else if (arg === "--no-open") opts.open = false;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version" || arg === "-v") opts.version = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (repoDir === null) repoDir = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (repoDir !== null) opts.repoDir = path.resolve(cwd, repoDir);
  return opts;
}

export const USAGE = `Usage: promptgraph [repo-dir] [--port 4777] [--no-open]`;
