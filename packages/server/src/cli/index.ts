#!/usr/bin/env node
import open from "open";
import { VERSION } from "../config/version.js";
import { resolveRepoRoot } from "../git/repo.js";
import { parseCliArgs, USAGE } from "./args.js";
import { checkPrereqs } from "./prereqs.js";
import { startServer } from "./server.js";

/**
 * `promptgraph` bin (§4): parseCliArgs → resolveRepoRoot → checkPrereqs (errors exit 1, warnings
 * printed) → startServer → print + open (unless --no-open) the URL. SIGINT/SIGTERM → server.close()
 * (graceful /exit of Claude PTYs, ≤5s) → exit 0; a second SIGINT force-exits.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }

  const prereqs = await checkPrereqs();
  for (const e of prereqs.errors) console.error(`error: ${e}`);
  if (prereqs.errors.length > 0) return 1;
  for (const w of prereqs.warnings) console.warn(`warning: ${w}`);

  let repoPath: string;
  try {
    repoPath = await resolveRepoRoot(opts.repoDir);
  } catch {
    console.error(`error: ${opts.repoDir} is not inside a git repository`);
    return 1;
  }

  const server = await startServer({ repoPath, port: opts.port, warnings: prereqs.warnings });
  console.log(`promptgraph ${VERSION} serving ${repoPath}`);
  console.log(`Open: ${server.url}`);
  if (opts.open) open(server.url).catch(() => console.warn("warning: could not open a browser; open the URL above"));

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) {
        if (signal === "SIGINT") process.exit(130);
        return;
      }
      stopping = true;
      console.log("\nStopping: asking running sessions to exit (up to 5s)…");
      server.close().then(
        () => resolve(0),
        (err: unknown) => {
          console.error(err instanceof Error ? err.message : err);
          resolve(1);
        },
      );
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
