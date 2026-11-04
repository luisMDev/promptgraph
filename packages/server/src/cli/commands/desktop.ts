import { DesktopInstallResultSchema, ShimResultSchema, type ShimResult } from "@promptgraph/shared";
import { installRuntime } from "../../desktop/runtime.js";
import { declineShim, installShim, ShimExistsError, shimStatus, uninstallShim } from "../../desktop/shim.js";
import type { CliOptions } from "../args.js";
import { CliError, runCommand, type CliDeps } from "../deps.js";

/**
 * `promptgraph desktop install --json` (internal, DESIGN §20.7): installs the bundled runtime this CLI
 * runs from into `<data>/runtime/<version>-<id8>` and prints one DesktopInstallResult line. Errors go to
 * stderr with exit 1 (the desktop shell shows them on the splash and does not fall back).
 */
export function runDesktopInstall(_opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const result = await installRuntime({ from: deps.runtimeRoot, env: deps.env, now: deps.now() });
    deps.stdout(JSON.stringify(DesktopInstallResultSchema.parse(result)));
    return 0;
  });
}

/**
 * `promptgraph desktop shim status|install [--replace]|decline|uninstall --json` (internal, DESIGN
 * §20.8): one ShimResult line. `install` on a foreign entry without `--replace` prints the ShimResult
 * with the foreign state, then `error: … exists` on stderr, exit 1.
 */
export function runDesktopShim(opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const print = (result: ShimResult) => deps.stdout(JSON.stringify(ShimResultSchema.parse(result)));
    switch (opts.shimAction) {
      case "status":
        print({ v: 1, shim: await shimStatus(deps.env), backup: null });
        return 0;
      case "install":
        try {
          print(await installShim(deps.env, { replace: opts.replace, version: deps.version, now: deps.now() }));
        } catch (err) {
          if (!(err instanceof ShimExistsError)) throw err;
          print({ v: 1, shim: err.status, backup: null });
          throw new CliError(`${err.message}; it exists (pass --replace to keep it as a backup and install the shim)`);
        }
        return 0;
      case "decline":
        print(await declineShim(deps.env, deps.now()));
        return 0;
      case "uninstall":
        print(await uninstallShim(deps.env, deps.now()));
        return 0;
      default:
        throw new CliError("desktop shim: missing action", 2);
    }
  });
}
