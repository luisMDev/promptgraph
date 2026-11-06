#!/usr/bin/env node
// Stages the self-contained runtime the desktop app bundles as its `runtime/` resource (DESIGN §20.6):
// the pinned official Node binary, the deployed server with its native modules, the web UI, a launcher
// and a manifest. Plain Node, no dependency beyond the workspace. The exports are for the tests; the CLI
// part runs only when this file is the main module.
//
//   node scripts/prepare-runtime.mjs [--stage <dir>] [--cache <dir>] [--skip-build]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");

/**
 * The pinned Node release. NODE_VERSION and NODE_SHA256 change together, in one commit, with the hash
 * copied from that release's SHASUMS256.txt (https://nodejs.org/dist/v<NODE_VERSION>/SHASUMS256.txt).
 * The script never trusts a checksum it downloads.
 */
export const NODE_VERSION = "24.22.2";
export const NODE_SHA256 = "48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75";
export const NODE_DIRNAME = `node-v${NODE_VERSION}-linux-x64`;
export const NODE_TARBALL = `${NODE_DIRNAME}.tar.xz`;

/** @returns {string} the https URL of the pinned tarball. */
export function nodeUrl() {
  return `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}`;
}

/** Staged runtimes larger than this fail the build (DESIGN §20.6: Node ~107 MB, server ≤ 40 MB, web ~7 MB). */
export const SIZE_BUDGET_BYTES = 170 * 1024 * 1024;

/**
 * The bin/promptgraph launcher. It resolves its own real path, so the Node binary and the CLI entry it
 * runs are always those of the same versioned directory, even through the `current` symlink or the
 * ~/.local/bin command. It exports no variable: the daemon derives everything from its own location.
 */
export const LAUNCHER = [
  "#!/bin/sh",
  "# promptgraph runtime launcher (DESIGN §20.6)",
  'self=$(readlink -f -- "$0") || exit 127',
  'dir=$(dirname -- "$(dirname -- "$self")")',
  'exec "$dir/node/bin/node" "$dir/server/dist/cli/index.js" "$@"',
  "",
].join("\n");

/**
 * The `pnpm deploy` of the server. Injected workspace packages (set for this command only) select pnpm
 * 10's lockfile-based deploy: the versions are exactly those of pnpm-lock.yaml (frozen: a stale lockfile
 * fails), and the checkout's own node_modules state is left alone. `--legacy` would resolve the ranges
 * again, ignoring the lockfile, and rewrite the checkout's .pnpm-workspace-state-v1.json.
 * @param {string} serverDir
 * @returns {string[]}
 */
export const DEPLOY_ARGS = (serverDir) => [
  "--filter",
  "@promptgraph/server",
  "--config.inject-workspace-packages=true",
  "deploy",
  "--prod",
  "--frozen-lockfile",
  "--config.node-linker=hoisted",
  // Real copies: the stage never shares inodes with the pnpm store.
  "--config.package-import-method=copy",
  serverDir,
];

/**
 * What is removed from `<stage>/server` after `pnpm deploy` (globs relative to it; `*` matches within one
 * path segment, dot names included). Entries starting with `!` are kept: a matched directory that holds
 * a kept path is descended into instead of removed, and its entries count as matched.
 */
export const PRUNE_PATHS = [
  // pnpm's own files: .bin holds symlinks, which the bundle must not contain.
  "node_modules/.bin",
  "node_modules/.modules.yaml",
  "node_modules/.pnpm",
  "node_modules/.package-lock.json",
  "node_modules/.pnpm-workspace-state-v1.json",
  "pnpm-lock.yaml",
  // Sources and configs of the workspace packages, should deploy ever copy them (both declare `files`).
  "src",
  "test",
  "tsconfig*.json",
  "node_modules/@promptgraph/shared/src",
  "node_modules/@promptgraph/shared/test",
  "node_modules/@promptgraph/shared/tsconfig*.json",
  // node-pty: only build/Release/pty.node (and spawn-helper, should it exist) is loaded at run time.
  "node_modules/node-pty/build/*",
  "node_modules/node-pty/build/Release/*",
  "node_modules/node-pty/build/Release/obj.target",
  "node_modules/node-pty/build/Release/.deps",
  "!node_modules/node-pty/build/Release/pty.node",
  "!node_modules/node-pty/build/Release/spawn-helper",
  "node_modules/node-pty/prebuilds",
  "node_modules/node-pty/deps",
  "node_modules/node-pty/third_party",
  "node_modules/node-pty/src",
  "node_modules/node-pty/scripts",
  "node_modules/node-pty/binding.gyp",
  // better-sqlite3: lib/binding.js loads prebuilds/linux-x64.node.
  "node_modules/better-sqlite3/deps",
  "node_modules/better-sqlite3/src",
  "node_modules/better-sqlite3/build",
  "node_modules/better-sqlite3/binding.gyp",
  "node_modules/better-sqlite3/prebuilds/*",
  "!node_modules/better-sqlite3/prebuilds/linux-x64.node",
];

/** @param {string} msg */
function log(msg) {
  process.stderr.write(`prepare-runtime: ${msg}\n`);
}

/** @param {string} pattern @returns {RegExp} one glob segment as a regex (`*` → any run of characters). */
function segmentRegex(pattern) {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replaceAll("*", ".*")}$`);
}

/** @param {string} glob @returns {RegExp[]} */
function compileGlob(glob) {
  return glob.split("/").map(segmentRegex);
}

/** @param {RegExp[]} pattern @param {string[]} segs @returns {boolean} the whole path matches. */
function matchesFully(pattern, segs) {
  return pattern.length === segs.length && pattern.every((re, i) => re.test(/** @type {string} */ (segs[i])));
}

/** @param {RegExp[]} pattern @param {string[]} segs @returns {boolean} the path is a proper ancestor of a match. */
function isAncestorOf(pattern, segs) {
  return pattern.length > segs.length && segs.every((s, i) => /** @type {RegExp} */ (pattern[i]).test(s));
}

/**
 * Removes the PRUNE_PATHS (or `patterns`) under `dir`, then every directory left empty (Tauri's resource
 * copy would not reproduce it anyway). Never follows a symlink. Returns the removed relative paths.
 * @param {string} dir
 * @param {readonly string[]} [patterns]
 * @returns {string[]}
 */
export function pruneTree(dir, patterns = PRUNE_PATHS) {
  const prune = patterns.filter((p) => !p.startsWith("!")).map(compileGlob);
  const keep = patterns.filter((p) => p.startsWith("!")).map((p) => compileGlob(p.slice(1)));
  /** @type {string[]} */
  const removed = [];
  /** @param {string} abs @param {string[]} segs @param {boolean} inherited */
  const walk = (abs, segs, inherited) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childSegs = [...segs, entry.name];
      const child = path.join(abs, entry.name);
      if (keep.some((k) => matchesFully(k, childSegs))) continue;
      const matched = inherited || prune.some((p) => matchesFully(p, childSegs));
      const isDir = entry.isDirectory();
      if (matched) {
        if (isDir && keep.some((k) => isAncestorOf(k, childSegs))) {
          walk(child, childSegs, true);
        } else {
          fs.rmSync(child, { recursive: true, force: true });
          removed.push(childSegs.join("/"));
        }
      } else if (isDir) {
        walk(child, childSegs, false);
      }
    }
  };
  walk(dir, [], false);
  removeEmptyDirs(dir, dir);
  return removed;
}

/** @param {string} root @param {string} abs @returns {boolean} whether `abs` was removed. */
function removeEmptyDirs(root, abs) {
  let empty = true;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory() && removeEmptyDirs(root, path.join(abs, entry.name))) continue;
    empty = false;
  }
  if (empty && abs !== root) {
    fs.rmdirSync(abs);
    return true;
  }
  return false;
}

/**
 * Every entry under `dir` (not following symlinks), as sorted relative POSIX paths.
 * @param {string} dir
 * @returns {{rel: string, abs: string, stat: fs.Stats}[]}
 */
function walkTree(dir) {
  /** @type {{rel: string, abs: string, stat: fs.Stats}[]} */
  const out = [];
  /** @param {string} abs @param {string} rel */
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(childAbs);
      out.push({ rel: childRel, abs: childAbs, stat });
      if (stat.isDirectory()) walk(childAbs, childRel);
    }
  };
  walk(dir, "");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Throws when anything under `dir` is a symlink: Tauri's resource copy drops symlinked directories and
 * turns symlinked files into copies, and the installer refuses them (DESIGN §20.6, §20.7).
 * @param {string} dir
 */
export function assertNoSymlinks(dir) {
  const links = walkTree(dir).filter((e) => e.stat.isSymbolicLink());
  if (links.length > 0) {
    const sample = links.slice(0, 5).map((e) => e.rel).join(", ");
    throw new Error(`the runtime stage contains ${links.length} symlink(s): ${sample}`);
  }
}

/** @param {string} dir @returns {number} total size in bytes of the regular files under `dir`. */
export function treeSize(dir) {
  return walkTree(dir).reduce((sum, e) => sum + (e.stat.isFile() ? e.stat.size : 0), 0);
}

/**
 * Throws when the files under `dir` exceed `budget` bytes.
 * @param {string} dir
 * @param {number} [budget]
 * @returns {number} the size
 */
export function assertWithinBudget(dir, budget = SIZE_BUDGET_BYTES) {
  const size = treeSize(dir);
  if (size > budget) {
    throw new Error(`the runtime stage is ${(size / 1048576).toFixed(1)} MB, over the ${(budget / 1048576).toFixed(0)} MB budget (DESIGN §20.6)`);
  }
  return size;
}

/** @param {string} file @returns {string} the hex SHA-256 of the file's content. */
export function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Checks the SHA-256 of `file`; on a mismatch the file is deleted and an error thrown.
 * @param {string} file
 * @param {string} expected
 */
export function verifySha256(file, expected) {
  const actual = sha256File(file);
  if (actual !== expected.toLowerCase()) {
    fs.rmSync(file, { force: true });
    throw new Error(`SHA-256 mismatch for ${path.basename(file)}: expected ${expected}, got ${actual}; the file was deleted`);
  }
}

/**
 * The build id of a staged runtime: SHA-256 over the sorted lines `relpath\0mode(octal)\0sha256(content)\n`
 * of every file but the top-level manifest.json.
 * @param {string} dir
 * @returns {string}
 */
export function computeBuildId(dir) {
  const hash = createHash("sha256");
  for (const e of walkTree(dir)) {
    if (e.stat.isDirectory()) continue;
    if (e.stat.isSymbolicLink()) throw new Error(`cannot compute a build id over a symlink: ${e.rel}`);
    if (e.rel === "manifest.json") continue;
    hash.update(`${e.rel}\0${(e.stat.mode & 0o777).toString(8)}\0${sha256File(e.abs)}\n`);
  }
  return hash.digest("hex");
}

/**
 * Throws, naming onlyBuiltDependencies, when the deployed node-pty has no compiled addon: pnpm skips the
 * builds it is not allowed to run, and pruning removes what a rebuild would need.
 * @param {string} serverDir
 */
export function assertPtyBuilt(serverDir) {
  const addon = path.join(serverDir, "node_modules", "node-pty", "build", "Release", "pty.node");
  if (!fs.existsSync(addon)) {
    throw new Error(
      `${addon} is missing: pnpm did not build node-pty. Make sure it is listed in onlyBuiltDependencies in pnpm-workspace.yaml and that python3, make and g++ are installed`,
    );
  }
}

/**
 * Writes `<dir>/manifest.json` (RuntimeManifestSchema of the built @promptgraph/shared, validated) with
 * the build id of everything else in `dir`. Call it last.
 * @param {string} dir
 * @param {{version: string, nodeVersion: string}} info
 * @returns {Promise<import("@promptgraph/shared").RuntimeManifest>}
 */
export async function writeManifest(dir, { version, nodeVersion }) {
  // Imported here, not at the top: the script builds @promptgraph/shared before it needs it.
  const { RuntimeManifestSchema } = await import("@promptgraph/shared");
  const manifest = RuntimeManifestSchema.parse({ v: 1, version, nodeVersion, platform: "linux-x64", buildId: computeBuildId(dir) });
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

/**
 * Downloads `url` to `dest` over https, following up to 5 redirects (each one https too).
 * @param {string} url
 * @param {string} dest
 * @returns {Promise<void>}
 */
export function downloadHttps(url, dest) {
  /** @param {string} current @param {number} left @returns {Promise<void>} */
  const get = (current, left) =>
    new Promise((resolve, reject) => {
      if (new URL(current).protocol !== "https:") {
        reject(new Error(`refusing a non-https URL: ${current}`));
        return;
      }
      const req = https.get(current, { headers: { "user-agent": "promptgraph-prepare-runtime" } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (left === 0) reject(new Error(`too many redirects for ${url}`));
          else get(new URL(res.headers.location, current).href, left - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`GET ${current}: HTTP ${status}`));
          return;
        }
        const part = `${dest}.part-${process.pid}`;
        const out = fs.createWriteStream(part, { mode: 0o644 });
        res.pipe(out);
        const fail = (/** @type {Error} */ err) => {
          out.destroy();
          fs.rmSync(part, { force: true });
          reject(err);
        };
        res.once("error", fail);
        out.once("error", fail);
        out.once("finish", () => {
          try {
            fs.renameSync(part, dest);
            resolve();
          } catch (err) {
            fail(/** @type {Error} */ (err));
          }
        });
      });
      req.setTimeout(120_000, () => req.destroy(new Error(`GET ${current}: timed out`)));
      req.once("error", reject);
    });
  return get(url, 5);
}

/**
 * The pinned tarball in `cacheDir`, downloaded when missing. Its SHA-256 is checked every time, whether
 * it was just downloaded or found in the cache; a mismatch deletes it and throws.
 * @param {string} cacheDir
 * @param {{expected?: string, url?: string, download?: (url: string, dest: string) => Promise<void>}} [opts]
 * @returns {Promise<string>} the tarball's path
 */
export async function obtainTarball(cacheDir, opts = {}) {
  const { expected = NODE_SHA256, url = nodeUrl(), download = downloadHttps } = opts;
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, path.basename(new URL(url).pathname));
  if (fs.existsSync(file)) {
    log(`cache hit ${file}; re-verifying its SHA-256`);
  } else {
    log(`downloading ${url}`);
    await download(url, file);
  }
  verifySha256(file, expected);
  log(`SHA-256 verified: ${path.basename(file)} ${expected}`);
  return file;
}

/**
 * @param {string} cmd
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [opts]
 */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.signal ?? `exit ${res.status}`})`);
  return res;
}

/**
 * Extracts bin/node and LICENSE of the verified tarball into `dir`, strips the binary and makes it 0755.
 * @param {string} tarball
 * @param {string} dir
 */
export function extractNode(tarball, dir) {
  fs.mkdirSync(dir, { recursive: true });
  run("tar", ["-xJf", tarball, "-C", dir, "--strip-components=1", `${NODE_DIRNAME}/bin/node`, `${NODE_DIRNAME}/LICENSE`]);
  const node = path.join(dir, "bin", "node");
  run("strip", [node]);
  fs.chmodSync(node, 0o755);
  fs.chmodSync(path.join(dir, "LICENSE"), 0o644);
  return node;
}

/** The default stage, the only place inside the repository a stage may be (DESIGN §20.6). */
export const DEFAULT_STAGE = path.join(DESKTOP_DIR, "runtime-stage");

/** The top-level entries a stage (complete, or left by a failed run) can hold. */
const STAGE_ENTRIES = new Set(["bin", "node", "server", "web", "manifest.json"]);

/**
 * `p` made absolute with symlinks resolved in its longest existing prefix (the rest need not exist).
 * @param {string} p
 */
function realResolve(p) {
  const abs = path.resolve(p);
  const rest = [];
  let dir = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/** @param {string} parent @param {string} child @returns {boolean} child is parent or inside it */
const within = (parent, child) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

/**
 * Refuses a stage path the script must not wipe (it removes the stage recursively before deploying):
 * - `/`, the home directory, the repository, or an ancestor of either;
 * - a path inside the repository other than the default stage (or a path below it), so a slip such as
 *   `--stage .` or `--stage src-tauri` from packages/desktop never deletes source or `.git`;
 * - an existing symlink, or an existing non-directory;
 * - an existing directory that does not look like a stage: a non-empty one must hold only stage entries
 *   (bin/, node/, server/, web/, manifest.json) and at least `server/` or `manifest.json`.
 * Paths are compared both as given and with symlinks resolved.
 * @param {string} stage
 * @param {{repoRoot?: string, home?: string, defaultStage?: string}} [where] overrides for the tests
 */
export function assertSafeStage(stage, { repoRoot = REPO_ROOT, home = os.homedir(), defaultStage = DEFAULT_STAGE } = {}) {
  const abs = path.resolve(stage);
  const refuse = (/** @type {string} */ why) => {
    throw new Error(`refusing to use ${abs} as the runtime stage: ${why}`);
  };
  const forms = [...new Set([abs, realResolve(abs)])];
  const repos = [...new Set([path.resolve(repoRoot), realResolve(repoRoot)])];
  const homes = [...new Set([path.resolve(home), realResolve(home)])];
  const defaults = [...new Set([path.resolve(defaultStage), realResolve(defaultStage)])];
  for (const p of forms) {
    if (p === path.parse(p).root) refuse("it is the filesystem root");
    if (homes.some((h) => within(p, h))) refuse("it is the home directory or one of its ancestors");
    if (repos.some((r) => within(p, r))) refuse("it is the repository or one of its ancestors");
    if (repos.some((r) => within(r, p)) && !defaults.some((d) => within(d, p))) {
      refuse(`inside the repository only ${path.relative(repoRoot, defaultStage)} (or a path below it) can be a stage`);
    }
  }
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) refuse("it is a symlink");
  if (!st.isDirectory()) refuse("it exists and is not a directory");
  const entries = fs.readdirSync(abs);
  if (entries.length === 0) return;
  const foreign = entries.filter((e) => !STAGE_ENTRIES.has(e));
  if (foreign.length > 0 || !(entries.includes("server") || entries.includes("manifest.json"))) {
    refuse(`it is not empty and does not look like a previous stage (found ${entries.slice(0, 5).map((e) => JSON.stringify(e)).join(", ")}${entries.length > 5 ? ", …" : ""})`);
  }
}

/** The script run by the smoke test inside `<stage>/server` with the staged Node. */
const SMOKE_SCRIPT = `
const Database = require("better-sqlite3");
const db = new Database(":memory:");
if (db.prepare("select 1 + 1 as n").get().n !== 2) throw new Error("better-sqlite3 returned a wrong result");
db.close();
const pty = require("node-pty");
const p = pty.spawn("/bin/echo", ["pg-smoke-ok"], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
let out = "";
p.onData((d) => (out += d));
const timer = setTimeout(() => { console.error("node-pty: no exit after 10 s"); process.exit(1); }, 10000);
p.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0 || !out.includes("pg-smoke-ok")) { console.error("node-pty: exit " + exitCode + ", output " + JSON.stringify(out)); process.exit(1); }
  console.log("native modules ok");
});
`;

/**
 * Runs the staged runtime with a minimal environment and a temporary HOME/PG_HOME: both native modules
 * load in the staged Node (sqlite :memory:, a pty running /bin/echo), and `bin/promptgraph --version`
 * prints the manifest's version.
 * @param {string} stage
 * @param {string} version
 */
export function smokeTest(stage, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-runtime-smoke-"));
  try {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    const env = { PATH: "/usr/bin:/bin", HOME: home, PG_HOME: path.join(tmp, "pg-home"), PG_PORT_DEFAULT: "0", LANG: "C.UTF-8" };
    const opts = { env, encoding: /** @type {const} */ ("utf8"), timeout: 30_000 };
    const node = spawnSync(path.join(stage, "node", "bin", "node"), ["-e", SMOKE_SCRIPT], { ...opts, cwd: path.join(stage, "server") });
    if (node.status !== 0) throw new Error(`smoke test: the native modules failed to load (${node.signal ?? `exit ${node.status}`}): ${node.error?.message ?? node.stderr}`);
    const cli = spawnSync(path.join(stage, "bin", "promptgraph"), ["--version"], { ...opts, cwd: tmp });
    const printed = (cli.stdout ?? "").trim();
    if (cli.status !== 0 || printed !== version) {
      throw new Error(`smoke test: bin/promptgraph --version printed ${JSON.stringify(printed)} (${cli.signal ?? `exit ${cli.status}`}), expected ${version}: ${cli.error?.message ?? cli.stderr}`);
    }
    log(`smoke test passed (native modules load, promptgraph --version = ${printed})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** @param {string[]} argv */
function parseCli(argv) {
  const { values } = parseArgs({
    // `pnpm runtime:prepare -- --cache x` passes the separator through.
    args: argv.filter((a) => a !== "--"),
    options: {
      stage: { type: "string" },
      cache: { type: "string" },
      "skip-build": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const cacheHome = process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME : path.join(os.homedir(), ".cache");
  return {
    help: values.help === true,
    stage: path.resolve(values.stage ?? DEFAULT_STAGE),
    cache: path.resolve(values.cache ?? path.join(cacheHome, "promptgraph-build")),
    skipBuild: values["skip-build"] === true,
  };
}

/** @param {string[]} argv */
async function main(argv) {
  const opts = parseCli(argv);
  if (opts.help) {
    process.stdout.write("usage: node scripts/prepare-runtime.mjs [--stage <dir>] [--cache <dir>] [--skip-build]\n");
    return;
  }
  assertSafeStage(opts.stage);
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error(`only linux-x64 is supported (this is ${process.platform}-${process.arch})`);

  // 1–2. Pinned Node, verified on every use.
  const tarball = await obtainTarball(opts.cache);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pg-runtime-node-"));
  try {
    // 3–4. bin/node and LICENSE only; strip; 0755.
    const extracted = path.join(work, "node");
    extractNode(tarball, extracted);

    // 5. Build the three packages the runtime ships.
    if (opts.skipBuild) log("--skip-build: reusing the built dist directories");
    else run("pnpm", ["--filter", "@promptgraph/shared", "--filter", "@promptgraph/server", "--filter", "@promptgraph/web", "build"], { cwd: REPO_ROOT });
    const webDist = path.join(REPO_ROOT, "packages", "web", "dist");
    if (!fs.existsSync(path.join(webDist, "index.html"))) throw new Error(`${webDist}/index.html is missing: build @promptgraph/web first`);

    // 6–7. A fresh stage, the server deployed with production dependencies only, hoisted (no symlink farm).
    // Checked again right before the removal: the build above ran for minutes.
    assertSafeStage(opts.stage);
    fs.rmSync(opts.stage, { recursive: true, force: true });
    fs.mkdirSync(opts.stage, { recursive: true });
    const serverDir = path.join(opts.stage, "server");
    run("pnpm", DEPLOY_ARGS(serverDir), { cwd: REPO_ROOT });

    // 8–9. The compiled pty addon must be there before pruning removes what a rebuild would need.
    assertPtyBuilt(serverDir);
    const removed = pruneTree(serverDir);
    log(`pruned ${removed.length} paths from server/`);
    assertPtyBuilt(serverDir);

    // 10–11. Node, the web UI and the launcher.
    fs.cpSync(extracted, path.join(opts.stage, "node"), { recursive: true });
    fs.cpSync(webDist, path.join(opts.stage, "web", "dist"), { recursive: true, dereference: true });
    fs.mkdirSync(path.join(opts.stage, "bin"));
    const launcher = path.join(opts.stage, "bin", "promptgraph");
    fs.writeFileSync(launcher, LAUNCHER, { mode: 0o755 });
    fs.chmodSync(launcher, 0o755);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // 12–13. Guards.
  assertNoSymlinks(opts.stage);
  const size = assertWithinBudget(opts.stage);
  log(`stage size ${(size / 1048576).toFixed(1)} MB (budget ${SIZE_BUDGET_BYTES / 1048576} MB)`);

  // 14. The manifest, last.
  const version = JSON.parse(fs.readFileSync(path.join(opts.stage, "server", "package.json"), "utf8")).version;
  const manifest = await writeManifest(opts.stage, { version, nodeVersion: NODE_VERSION });
  log(`manifest: version ${manifest.version}, node ${manifest.nodeVersion}, buildId ${manifest.buildId}`);

  // 15. Smoke test; a failed stage keeps no manifest, so it is never mistaken for a runtime.
  try {
    smokeTest(opts.stage, manifest.version);
  } catch (err) {
    fs.rmSync(path.join(opts.stage, "manifest.json"), { force: true });
    throw err;
  }
  log(`staged ${opts.stage}`);
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedAs === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
