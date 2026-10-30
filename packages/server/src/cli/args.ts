export interface CliOptions {
  /** Default cwd; resolved to the git top-level later. */
  repoDir: string;
  /** Default 4777 (`PG_PORT_DEFAULT` env overrides for tests). */
  port: number;
  open: boolean;
  help: boolean;
  version: boolean;
}

/** `promptgraph [repo-dir] [--port 4777] [--no-open] [--help] [--version]` (§4). @throws on bad args. */
export function parseCliArgs(argv: readonly string[], cwd?: string): CliOptions {
  throw new Error("not implemented");
}

export const USAGE = `Usage: promptgraph [repo-dir] [--port 4777] [--no-open]`;
