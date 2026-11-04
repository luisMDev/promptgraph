import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  MCP_SKILLS,
  MCP_TOOL_GROUPS,
  type ClaudeCheckResponse,
  type ClaudeSetupResponse,
} from "@promptgraph/shared";
import { claudeBin } from "../config/child-env.js";
import { SERVER_PACKAGE_DIR } from "../config/paths.js";
import { VERSION } from "../config/version.js";
import { readManifest } from "../desktop/runtime.js";
import { errorMessage, tailLines } from "../util/text.js";

/** Quotes one shell word: plain words stay bare, anything else is single-quoted. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Repository root that bundles the plugin (the checkout that has .claude-plugin/marketplace.json), or null. */
export function bundledMarketplaceRoot(serverPackageDir: string = SERVER_PACKAGE_DIR): string | null {
  const root = path.resolve(serverPackageDir, "..", "..");
  return fs.existsSync(path.join(root, ".claude-plugin", "marketplace.json")) ? root : null;
}

export interface CliCommandInputs {
  /** The directory the daemon's code runs from (`SERVER_PACKAGE_DIR/..`: a runtime root when bundled). */
  serverRoot?: string;
  /** Node binary running the CLI (process.execPath). */
  nodePath: string;
  /** Entry point of the daemon's promptgraph CLI (process.argv[1]). */
  cliEntry: string;
}

/**
 * The command that runs this promptgraph CLI for the setup wizard (DESIGN §19.5): the stable launcher
 * `<parent>/current/bin/promptgraph` when `serverRoot` is an installed desktop runtime (a valid
 * manifest.json) and `<parent>/current` resolves to that very directory, so the command survives
 * updates; else `[nodePath, cliEntry]`. Derived from the daemon's own location only: no environment
 * variable is read, so an inherited `PG_CLI_PATH` (or any other) cannot put a foreign path into
 * `claude mcp add`.
 */
export function cliCommandFor({ serverRoot = path.resolve(SERVER_PACKAGE_DIR, ".."), nodePath, cliEntry }: CliCommandInputs): string[] {
  try {
    if (readManifest(serverRoot)) {
      const parent = path.dirname(path.resolve(serverRoot));
      const current = path.join(parent, "current");
      if (fs.realpathSync(current) === fs.realpathSync(serverRoot)) return [path.join(current, "bin", "promptgraph")];
    }
  } catch {
    // No `current`, or it does not resolve: the versioned paths below.
  }
  return [nodePath, cliEntry];
}

export interface SetupInputs {
  repoPath: string;
  /** cliCommandFor(...): argv that runs the daemon's promptgraph CLI; `mcp` is appended. */
  cliCommand: readonly string[];
  marketplaceRoot: string | null;
  version?: string;
}

/** Everything the setup wizard shows, derived from the running daemon (no side effects). */
export function buildClaudeSetup(input: SetupInputs): ClaudeSetupResponse {
  const { cliCommand, marketplaceRoot } = input;
  const mcpAddCommand = ["claude", "mcp", "add", "promptgraph", "--", ...cliCommand, "mcp"].map(shellQuote).join(" ");
  return {
    version: input.version ?? VERSION,
    repoPath: input.repoPath,
    // What PROMPTGRAPH_BIN must name: an executable that takes `mcp` (the launcher, or the CLI entry).
    binPath: cliCommand.at(-1) ?? "promptgraph",
    mcpAddCommand,
    plugin: {
      available: marketplaceRoot !== null,
      marketplacePath: marketplaceRoot,
      addMarketplaceCommand: marketplaceRoot ? `/plugin marketplace add ${shellQuote(marketplaceRoot)}` : null,
      installCommand: "/plugin install promptgraph@promptgraph",
    },
    skills: [...MCP_SKILLS],
    toolGroups: [...MCP_TOOL_GROUPS],
  };
}

const CHECK_TIMEOUT_MS = 15_000;

/** Names promptgraph can be registered under: by `claude mcp add`, or by the plugin. */
const PROMPTGRAPH_SERVER_NAMES = ["promptgraph", "plugin:promptgraph:promptgraph"] as const;

export interface ClaudeCheckOptions {
  env?: NodeJS.ProcessEnv;
  /** The repository: `claude mcp add` registers at local scope by default, and local and project scopes depend on the directory. */
  cwd: string;
}

/**
 * Looks the server up with `claude mcp get <name>` in the repository, which only reads the configuration
 * (`claude mcp list` health-checks every server and can take minutes). Exit 0 = listed, 1 = not listed.
 */
export async function checkClaudeSetup({ env = process.env, cwd }: ClaudeCheckOptions): Promise<ClaudeCheckResponse> {
  const lookups = await Promise.all(PROMPTGRAPH_SERVER_NAMES.map((name) => getMcpServer(name, env, cwd)));
  if (lookups.some((l) => l.kind === "missing-binary")) {
    return { claudeFound: false, mcpRegistered: false, output: "The claude command was not found on PATH." };
  }
  const found = lookups.find((l) => l.kind === "found");
  if (found) return { claudeFound: true, mcpRegistered: true, output: tailLines(found.output, 30) };
  const reason = lookups.map((l) => (l.kind === "error" ? l.output : "")).find(Boolean);
  return { claudeFound: true, mcpRegistered: false, output: reason ? tailLines(reason, 30) : "No promptgraph MCP server is configured." };
}

type Lookup = { kind: "found"; output: string } | { kind: "not-found" } | { kind: "error"; output: string } | { kind: "missing-binary" };

function getMcpServer(name: string, env: NodeJS.ProcessEnv, cwd: string): Promise<Lookup> {
  return new Promise((resolve) => {
    execFile(claudeBin(env), ["mcp", "get", name], { env, cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      if (!err) return resolve({ kind: "found", output });
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolve({ kind: "missing-binary" });
      if (typeof err.code === "number" && err.code === 1) return resolve({ kind: "not-found" });
      resolve({ kind: "error", output: output || errorMessage(err) });
    });
  });
}

/** The promptgraph CLI entry of the running process, resolved to an absolute path. */
export function currentCliEntry(argv1: string | undefined = process.argv[1]): string {
  return path.resolve(argv1 ?? "promptgraph");
}
