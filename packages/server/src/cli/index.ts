#!/usr/bin/env node
/**
 * `promptgraph` bin (§4): parseCliArgs → resolveRepoRoot → checkPrereqs (errors exit 1, warnings
 * printed) → startServer → print + open (unless --no-open) the URL. SIGINT/SIGTERM → server.close()
 * (graceful /exit of Claude PTYs, ≤5s) → exit 0; a second SIGINT force-exits.
 */
export async function main(argv: readonly string[]): Promise<number> {
  throw new Error("not implemented");
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
