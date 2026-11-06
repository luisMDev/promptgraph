import fs from "node:fs";
import path from "node:path";
import { DesktopInstallResultSchema } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { runDesktopInstall } from "../src/cli/commands/desktop.js";
import type { CliDeps } from "../src/cli/deps.js";
import { getPaths } from "../src/config/paths.js";
import { desktopPaths } from "../src/desktop/paths.js";
import {
  activateRuntime,
  installRuntime,
  isInstalledRuntime,
  nativeSelfCheck,
  NotARuntimeError,
  pruneRuntimes,
  RuntimeDirError,
  type ProcReader,
} from "../src/desktop/runtime.js";
import { desktopEnv, fakeBuildId, makeRuntime } from "./desktop-fixtures.js";
import { tempDir } from "./helpers.js";

const okCheck = async () => undefined;

/** A /proc stand-in: `exes` maps pid → executable; every listed pid (and `alive`) is alive. */
function fakeProc(exes: Record<number, string> = {}, alive: number[] = []): ProcReader {
  return {
    pids: () => Object.keys(exes).map(Number),
    exe: (pid) => exes[pid] ?? null,
    alive: (pid) => pid in exes || alive.includes(pid),
  };
}

describe("desktop runtime installation (DESIGN §20.7)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  function setup() {
    const t = tempDir("pg-desktop-runtime-");
    cleanups.push(t.cleanup);
    const env = desktopEnv(t.dir);
    const paths = desktopPaths(env);
    /** A bundled runtime (as an AppImage mount would hold it) of `version`. */
    const bundle = (version: string, extra: { buildId?: string; node?: string } = {}) => {
      const dir = path.join(t.dir, "bundles", `${version}-${Math.random().toString(16).slice(2, 8)}`);
      const manifest = makeRuntime(dir, { version, ...extra });
      return { dir, manifest, name: `${version}-${manifest.buildId.slice(0, 8)}` };
    };
    return { root: t.dir, env, paths, bundle };
  }

  const readCurrent = (runtimeDir: string) => fs.readlinkSync(path.join(runtimeDir, "current"));

  it("a first install copies the build, sets current (relative, atomic) and reports the shim", async () => {
    const { env, paths, bundle } = setup();
    const b = bundle("0.2.0");
    const result = DesktopInstallResultSchema.parse(await installRuntime({ from: b.dir, env, selfCheck: okCheck, proc: fakeProc() }));
    const root = path.join(paths.runtimeDir, b.name);
    expect(result).toEqual({
      v: 1,
      version: "0.2.0",
      root,
      cliPath: path.join(root, "bin", "promptgraph"),
      current: b.name,
      installed: true,
      pruned: [],
      shim: { path: paths.shimPath, state: "absent", foreignTarget: null, decision: null, onPath: null, shadowedBy: null, pathHint: null, warn: false },
    });
    expect(paths.runtimeDir).toBe(path.join(env.XDG_DATA_HOME!, "promptgraph", "runtime"));
    expect(fs.statSync(paths.runtimeDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))).toEqual(b.manifest);
    expect(fs.statSync(path.join(root, "bin", "promptgraph")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, "node", "bin", "node")).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(root, "web", "dist", "index.html"), "utf8")).toContain("doctype");
    // current is a relative symlink, switched by rename: no temporary link or staging dir is left.
    expect(fs.lstatSync(paths.currentLink).isSymbolicLink()).toBe(true);
    expect(readCurrent(paths.runtimeDir)).toBe(b.name);
    expect(fs.readdirSync(paths.runtimeDir).sort()).toEqual([b.name, "current"].sort());
    expect(isInstalledRuntime(root)).toBe(true);
    expect(isInstalledRuntime(path.join(paths.runtimeDir, "current"))).toBe(true);
    expect(isInstalledRuntime(b.dir)).toBe(false);
  });

  it("installing another version keeps current (installing is not activating); a re-install is a no-op", async () => {
    const { env, paths, bundle } = setup();
    const a = bundle("0.2.0");
    const b = bundle("0.3.0");
    await installRuntime({ from: a.dir, env, selfCheck: okCheck, proc: fakeProc() });
    const second = await installRuntime({ from: b.dir, env, selfCheck: okCheck, proc: fakeProc() });
    expect(second).toMatchObject({ version: "0.3.0", installed: true, current: a.name, pruned: [], cliPath: path.join(paths.runtimeDir, b.name, "bin", "promptgraph") });
    expect(readCurrent(paths.runtimeDir)).toBe(a.name);
    expect(fs.existsSync(path.join(paths.runtimeDir, a.name, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(paths.runtimeDir, b.name, "manifest.json"))).toBe(true);

    let checks = 0;
    const again = await installRuntime({ from: b.dir, env, selfCheck: async () => void checks++, proc: fakeProc() });
    expect(again).toMatchObject({ installed: false, current: a.name });
    expect(checks).toBe(0);
  });

  it("a broken current is repaired by the next install", async () => {
    const { env, paths, bundle } = setup();
    const a = bundle("0.2.0");
    await installRuntime({ from: a.dir, env, selfCheck: okCheck, proc: fakeProc() });
    fs.unlinkSync(paths.currentLink);
    fs.symlinkSync("0.1.0-deadbeef", paths.currentLink);
    expect((await installRuntime({ from: a.dir, env, selfCheck: okCheck, proc: fakeProc() })).current).toBe(a.name);
    expect(readCurrent(paths.runtimeDir)).toBe(a.name);
  });

  it("a partial target (no valid manifest) is replaced", async () => {
    const { env, paths, bundle } = setup();
    const a = bundle("0.2.0");
    const target = path.join(paths.runtimeDir, a.name);
    fs.mkdirSync(path.join(target, "server"), { recursive: true });
    fs.writeFileSync(path.join(target, "server", "junk"), "half-copied");
    fs.writeFileSync(path.join(target, "manifest.json"), "{not json");
    const result = await installRuntime({ from: a.dir, env, selfCheck: okCheck, proc: fakeProc() });
    expect(result).toMatchObject({ installed: true, current: a.name });
    expect(fs.existsSync(path.join(target, "server", "junk"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"))).toEqual(a.manifest);
  });

  it("a failing self-check leaves no target, no staging and current unchanged", async () => {
    const { env, paths, bundle } = setup();
    const a = bundle("0.2.0");
    const b = bundle("0.3.0");
    await installRuntime({ from: a.dir, env, selfCheck: okCheck, proc: fakeProc() });
    let staged: string | null = null;
    await expect(
      installRuntime({
        from: b.dir,
        env,
        proc: fakeProc(),
        selfCheck: async (dir) => {
          staged = dir;
          // The manifest is copied last: never present while the check runs.
          expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(false);
          throw new Error("better-sqlite3 was compiled against a different Node.js version");
        },
      }),
    ).rejects.toThrow(`the bundled runtime ${b.name} failed its self-check: better-sqlite3 was compiled`);
    expect(staged).toMatch(/\/\.staging-[0-9a-f]{8}-\d+$/);
    expect(fs.existsSync(path.join(paths.runtimeDir, b.name))).toBe(false);
    expect(fs.readdirSync(paths.runtimeDir).sort()).toEqual([a.name, "current"].sort());
    expect(readCurrent(paths.runtimeDir)).toBe(a.name);
  });

  it("refuses a bundle with a symlink (cpSync would point it into the AppImage mount)", async () => {
    const { env, paths, bundle } = setup();
    const b = bundle("0.2.0");
    fs.symlinkSync("../server/package.json", path.join(b.dir, "bin", "rel"));
    await expect(installRuntime({ from: b.dir, env, selfCheck: okCheck, proc: fakeProc() })).rejects.toThrow("the bundled runtime contains a symlink: bin/rel");
    expect(fs.readdirSync(paths.runtimeDir)).toEqual([]);
  });

  it("pruning is best effort: an unremovable old build does not fail the install", async () => {
    const { env, paths, bundle } = setup();
    const old = bundle("0.1.0");
    const cur = bundle("0.2.0");
    await installRuntime({ from: old.dir, env, selfCheck: okCheck, proc: fakeProc() });
    await installRuntime({ from: cur.dir, env, selfCheck: okCheck, proc: fakeProc({ 1: path.join(paths.runtimeDir, old.name, "node/bin/node") }) });
    await activateRuntime(path.join(paths.runtimeDir, cur.name));
    // A read-only subdirectory makes the recursive removal fail with EACCES.
    const locked = path.join(paths.runtimeDir, old.name, "server");
    fs.chmodSync(locked, 0o555);
    cleanups.unshift(() => fs.chmodSync(locked, 0o755));
    const next = bundle("0.3.0");
    const result = await installRuntime({ from: next.dir, env, selfCheck: okCheck, proc: fakeProc() });
    expect(result.installed).toBe(true);
    expect(result.pruned).not.toContain(old.name);
    expect(fs.existsSync(path.join(paths.runtimeDir, next.name, "manifest.json"))).toBe(true);
  });

  it("the default self-check runs the staged node from server/ (a tiny fake node)", async () => {
    const { env, paths, bundle } = setup();
    const good = bundle("0.2.0", { node: '[ "$1" = -e ] && [ "$(basename "$PWD")" = server ] && exit 0; exit 9' });
    expect((await installRuntime({ from: good.dir, env, proc: fakeProc() })).installed).toBe(true);
    const bad = bundle("0.3.0", { node: 'echo "Error: NODE_MODULE_VERSION mismatch" >&2; exit 1' });
    await expect(installRuntime({ from: bad.dir, env, proc: fakeProc() })).rejects.toThrow(/could not load its native modules \(exit 1\): Error: NODE_MODULE_VERSION mismatch/);
    expect(fs.existsSync(path.join(paths.runtimeDir, bad.name))).toBe(false);
    await expect(nativeSelfCheck(path.join(paths.runtimeDir, good.name), env)).resolves.toBeUndefined();
  });

  it("refuses a directory that is not a bundled runtime", async () => {
    const { env, root } = setup();
    const dir = path.join(root, "checkout");
    makeRuntime(dir, { version: "0.2.0", noManifest: true });
    await expect(installRuntime({ from: dir, env, selfCheck: okCheck })).rejects.toThrow(NotARuntimeError);
    await expect(installRuntime({ from: dir, env, selfCheck: okCheck })).rejects.toThrow("this promptgraph is not a bundled desktop runtime");
  });

  it("prunes builds no process runs from, but keeps current's target, the new build and in-use builds", async () => {
    const { env, paths, bundle } = setup();
    const old1 = bundle("0.1.0");
    const old2 = bundle("0.1.1");
    const cur = bundle("0.2.0");
    const next = bundle("0.3.0");
    // Install the old builds without pruning in between, then make 0.2.0 current.
    for (const b of [old1, old2]) await installRuntime({ from: b.dir, env, selfCheck: okCheck, proc: fakeProc({ 1: "/x" }) });
    await installRuntime({ from: cur.dir, env, selfCheck: okCheck, proc: fakeProc({ 1: path.join(paths.runtimeDir, old1.name, "node/bin/node"), 2: path.join(paths.runtimeDir, old2.name, "node/bin/node") }) });
    await activateRuntime(path.join(paths.runtimeDir, cur.name));
    // Stale staging of a dead process, and one of a live process.
    fs.mkdirSync(path.join(paths.runtimeDir, ".staging-deadbeef-999999"));
    fs.mkdirSync(path.join(paths.runtimeDir, ".staging-cafebabe-4242"));
    // An old daemon (or `promptgraph mcp`) still runs from old1; nothing runs from old2.
    const proc = fakeProc({ 77: path.join(paths.runtimeDir, old1.name, "node", "bin", "node"), 78: "/usr/bin/bash" }, [4242]);
    const result = await installRuntime({ from: next.dir, env, selfCheck: okCheck, proc });
    expect(result.pruned.sort()).toEqual([".staging-deadbeef-999999", old2.name].sort());
    expect(fs.readdirSync(paths.runtimeDir).sort()).toEqual([".staging-cafebabe-4242", old1.name, cur.name, next.name, "current"].sort());
    expect(result.current).toBe(cur.name);
    // Once the old daemon is gone, a later start removes its build.
    expect(pruneRuntimes(paths.runtimeDir, { keep: [cur.name, next.name], proc: fakeProc() }).sort()).toEqual([".staging-cafebabe-4242", old1.name].sort());
  });

  it("concurrent installs are serialised by the runtime lock", async () => {
    const { env, paths, bundle } = setup();
    const builds = [bundle("0.2.0"), bundle("0.3.0"), bundle("0.4.0")];
    let active = 0;
    let maxActive = 0;
    const slowCheck = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 150));
      active--;
    };
    const results = await Promise.all(builds.map((b) => installRuntime({ from: b.dir, env, selfCheck: slowCheck, proc: fakeProc() })));
    expect(maxActive).toBe(1);
    expect(results.every((r) => r.installed)).toBe(true);
    // Exactly one of them set current (the first to take the lock), and the others agree.
    expect(new Set(results.map((r) => r.current)).size).toBe(1);
    expect(readCurrent(paths.runtimeDir)).toBe(results[0]!.current);
  });

  it("refuses a symlinked runtime directory and directories of another uid; tightens a loose mode", async () => {
    const { env, paths, bundle, root } = setup();
    const a = bundle("0.2.0");
    // Loose mode: tightened.
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(paths.runtimeDir, 0o755);
    await installRuntime({ from: a.dir, env, selfCheck: okCheck, proc: fakeProc() });
    expect(fs.statSync(paths.runtimeDir).mode & 0o777).toBe(0o700);

    // Another uid owns the data dir (injected: tests cannot chown).
    await expect(installRuntime({ from: a.dir, env, selfCheck: okCheck, uid: 12345 })).rejects.toThrow(RuntimeDirError);
    await expect(installRuntime({ from: a.dir, env, selfCheck: okCheck, uid: 12345 })).rejects.toThrow("belongs to another user");

    // A symlinked runtime dir.
    const env2 = desktopEnv(path.join(root, "second"));
    const p2 = desktopPaths(env2);
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.mkdirSync(p2.dataDir, { recursive: true });
    fs.symlinkSync(elsewhere, p2.runtimeDir);
    await expect(installRuntime({ from: a.dir, env: env2, selfCheck: okCheck })).rejects.toThrow(/is a symbolic link/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("activateRuntime switches current atomically to an installed build only", async () => {
    const { env, paths, bundle } = setup();
    const a = bundle("0.2.0");
    const b = bundle("0.3.0");
    await installRuntime({ from: a.dir, env, selfCheck: okCheck, proc: fakeProc() });
    await installRuntime({ from: b.dir, env, selfCheck: okCheck, proc: fakeProc() });
    expect(await activateRuntime(path.join(paths.runtimeDir, b.name))).toEqual({ switched: true, current: b.name });
    expect(readCurrent(paths.runtimeDir)).toBe(b.name);
    expect(await activateRuntime(path.join(paths.runtimeDir, b.name))).toEqual({ switched: false, current: b.name });
    expect(fs.readdirSync(paths.runtimeDir).filter((n) => n.startsWith(".current-"))).toEqual([]);
    await expect(activateRuntime(b.dir)).rejects.toThrow("is not an installed promptgraph runtime");
    // A directory with a manifest whose name does not match it is not an installed build either.
    const renamed = path.join(paths.runtimeDir, "0.9.0-00000000");
    fs.cpSync(path.join(paths.runtimeDir, a.name), renamed, { recursive: true });
    expect(isInstalledRuntime(renamed)).toBe(false);
    expect(readCurrent(paths.runtimeDir)).toBe(b.name);
  });

  it("an installed build is recognised from its own location, whatever the environment says (DESIGN §4.3)", async () => {
    const { env, paths, bundle } = setup();
    const a = bundle("0.2.0");
    const b = bundle("0.3.0");
    await installRuntime({ from: a.dir, env, selfCheck: okCheck, proc: fakeProc() });
    await installRuntime({ from: b.dir, env, selfCheck: okCheck, proc: fakeProc() });
    const root = path.join(paths.runtimeDir, b.name);
    // No environment is read: an XDG_DATA_HOME that only the login shell exports changes nothing.
    expect(isInstalledRuntime(root)).toBe(true);
    expect(await activateRuntime(root)).toEqual({ switched: true, current: b.name });
    expect(readCurrent(paths.runtimeDir)).toBe(b.name);
    // Another user's runtime directory, and one anyone can write to, are not ours to switch.
    expect(isInstalledRuntime(root, process.getuid!() + 1)).toBe(false);
    fs.chmodSync(paths.runtimeDir, 0o777);
    expect(isInstalledRuntime(root)).toBe(false);
    await expect(activateRuntime(root)).rejects.toThrow("is not an installed promptgraph runtime");
    fs.chmodSync(paths.runtimeDir, 0o700);
    // Without `current` it is no installed runtime either (desktop install always sets one).
    fs.unlinkSync(paths.currentLink);
    expect(isInstalledRuntime(root)).toBe(false);
    // A build copied into a directory not named runtime is not one.
    const copy = path.join(paths.dataDir, "elsewhere", b.name);
    fs.cpSync(root, copy, { recursive: true });
    fs.symlinkSync(b.name, path.join(paths.dataDir, "elsewhere", "current"));
    expect(isInstalledRuntime(copy)).toBe(false);
  });

  it("`desktop install --json` prints one DesktopInstallResult line; a checkout is refused (exit 1)", async () => {
    const { env, root, bundle } = setup();
    const a = bundle("0.2.0", { buildId: fakeBuildId("cli") });
    const out: string[] = [];
    const err: string[] = [];
    const deps = (runtimeRoot: string): CliDeps => ({
      paths: getPaths({ PG_HOME: path.join(root, "pg-home") }),
      env,
      cwd: root,
      stdout: (l) => void out.push(l),
      stderr: (l) => void err.push(l),
      openBrowser: async () => undefined,
      now: () => 1000,
      sleep: async () => undefined,
      serverCommand: [],
      version: "0.2.0",
      runtimeRoot,
    });
    expect(await runDesktopInstall(parseCliArgs(["desktop", "install", "--json"]), deps(a.dir))).toBe(0);
    expect(out).toHaveLength(1);
    expect(DesktopInstallResultSchema.parse(JSON.parse(out[0]!))).toMatchObject({ version: "0.2.0", installed: true, current: a.name });
    expect(err).toEqual([]);

    out.length = 0;
    expect(await runDesktopInstall(parseCliArgs(["desktop", "install", "--json"]), deps(path.join(root, "nowhere")))).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([expect.stringContaining("error: this promptgraph is not a bundled desktop runtime")]);
  });
});
