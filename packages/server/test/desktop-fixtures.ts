import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeManifest } from "@promptgraph/shared";

/** HOME and the XDG directories in `root` (tests never read or write the real ones). */
export function desktopEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    SHELL: "/bin/sh",
    ...extra,
  };
}

/** A deterministic 64-hex build id for a fixture. */
export function fakeBuildId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export interface FixtureRuntimeOptions {
  version: string;
  buildId?: string;
  /** Body of the fake `node/bin/node` (a sh script). Default: exit 0. */
  node?: string;
  /** Skip manifest.json (not a runtime). */
  noManifest?: boolean;
}

/**
 * A tiny bundled-runtime tree (DESIGN §20.6 layout) at `dir`: manifest.json, bin/promptgraph, a fake
 * node/bin/node, server/ and web/dist/.
 */
export function makeRuntime(dir: string, opts: FixtureRuntimeOptions): RuntimeManifest {
  const manifest: RuntimeManifest = {
    v: 1,
    version: opts.version,
    nodeVersion: "24.22.2",
    platform: "linux-x64",
    buildId: opts.buildId ?? fakeBuildId(`${opts.version}:${dir}`),
  };
  const write = (rel: string, content: string, mode = 0o644) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
    fs.chmodSync(file, mode);
  };
  write("bin/promptgraph", '#!/bin/sh\nd=$(dirname "$(dirname "$(readlink -f "$0")")")\nexec "$d/node/bin/node" "$d/server/dist/cli/index.js" "$@"\n', 0o755);
  write("node/bin/node", `#!/bin/sh\n${opts.node ?? "exit 0"}\n`, 0o755);
  write("node/LICENSE", "MIT\n");
  write("server/package.json", JSON.stringify({ name: "@promptgraph/server", version: opts.version }));
  write("server/dist/cli/index.js", `console.log(${JSON.stringify(opts.version)});\n`);
  write("server/node_modules/better-sqlite3/index.js", "module.exports = {};\n");
  write("web/dist/index.html", "<!doctype html>\n");
  if (!opts.noManifest) write("manifest.json", `${JSON.stringify(manifest)}\n`);
  return manifest;
}
