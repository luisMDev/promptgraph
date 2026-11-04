import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SHIM_MARKER, ShimResultSchema } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { runDesktopShim } from "../src/cli/commands/desktop.js";
import type { CliDeps } from "../src/cli/deps.js";
import { getPaths } from "../src/config/paths.js";
import { desktopPaths } from "../src/desktop/paths.js";
import { readPrefs, recordShimDecision, writePrefs } from "../src/desktop/prefs.js";
import { installRuntime } from "../src/desktop/runtime.js";
import {
  checkBinDir,
  declineShim,
  installShim,
  isPrivateGroup,
  pathCheck,
  pathHintFor,
  refreshShim,
  ShimDirError,
  ShimExistsError,
  shimScript,
  shimStatus,
  shimTarget,
  uninstallShim,
  type PathCheck,
} from "../src/desktop/shim.js";
import { desktopEnv, makeRuntime } from "./desktop-fixtures.js";
import { tempDir } from "./helpers.js";

const OK: PathCheck = { onPath: true, shadowedBy: null, pathHint: null };
const NOT_ON_PATH: PathCheck = { onPath: false, shadowedBy: null, pathHint: "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.profile" };
const okCheck = async () => OK;

describe("the promptgraph command in ~/.local/bin (DESIGN §20.8)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  function setup(extra: Record<string, string> = {}) {
    const t = tempDir("pg-desktop-shim-");
    cleanups.push(t.cleanup);
    const env = desktopEnv(t.dir, extra);
    return { root: t.dir, env, paths: desktopPaths(env) };
  }

  /** A fake $SHELL that ignores `-ilc <cmd>` and prints an environment whose PATH is `pathValue`. */
  function fakeShell(root: string, pathValue: string): string {
    const file = path.join(root, "fake-login-shell");
    fs.writeFileSync(file, `#!/bin/sh\necho "motd: welcome"\nprintf '%s\\n' ${JSON.stringify(JSON.stringify({ PATH: pathValue, HOME: "/ignored" }))}\n`, { mode: 0o755 });
    return file;
  }

  it("writes the exact shim text, pointing at current, which runs the current runtime", async () => {
    const { env, paths, root } = setup();
    const target = shimTarget(paths);
    expect(target).toBe(path.join(env.XDG_DATA_HOME!, "promptgraph", "runtime", "current", "bin", "promptgraph"));
    const text = shimScript("/home/o'neil/.local/share/promptgraph/runtime/current/bin/promptgraph");
    expect(text.split("\n")).toEqual([
      "#!/bin/sh",
      `${SHIM_MARKER}: written by the promptgraph desktop app, which rewrites or removes only files with this line.`,
      `t='/home/o'\\''neil/.local/share/promptgraph/runtime/current/bin/promptgraph'`,
      `[ -x "$t" ] || { echo "promptgraph: the desktop app's runtime is missing ($t); open the app once, or remove $0" >&2; exit 127; }`,
      'exec "$t" "$@"',
      "",
    ]);

    const result = await installShim(env, { replace: false, version: "0.2.0", pathCheck: okCheck, now: 5 });
    expect(result).toEqual({
      v: 1,
      backup: null,
      shim: { path: paths.shimPath, state: "ours", foreignTarget: null, decision: "accepted", onPath: true, shadowedBy: null, pathHint: null, warn: false },
    });
    expect(fs.statSync(paths.shimPath).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(paths.binDir)).toEqual(["promptgraph"]);
    // Without a runtime it explains itself (exit 127); with one it runs current's launcher.
    let failure: { status: number; stderr: string } | null = null;
    try {
      execFileSync(paths.shimPath, ["--version"], { stdio: "pipe" });
    } catch (err) {
      failure = { status: (err as { status: number }).status, stderr: String((err as { stderr: Buffer }).stderr) };
    }
    expect(failure).toMatchObject({ status: 127, stderr: expect.stringContaining("the desktop app's runtime is missing") });
    const bundle = path.join(root, "bundle");
    makeRuntime(bundle, { version: "0.2.0", node: 'echo "node $*"' });
    await installRuntime({ from: bundle, env, selfCheck: async () => undefined, pathCheck: okCheck });
    expect(execFileSync(paths.shimPath, ["mcp"], { encoding: "utf8" })).toMatch(/^node \S+\/runtime\/0\.2\.0-[0-9a-f]{8}\/server\/dist\/cli\/index\.js mcp$/m);
  });

  it("reports absent, ours, foreign (file, symlink, dangling symlink)", async () => {
    const { env, paths, root } = setup();
    expect(await shimStatus(env)).toMatchObject({ state: "absent", foreignTarget: null, decision: null, warn: false });
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.shimPath, "#!/bin/sh\necho npm global\n", { mode: 0o755 });
    expect(await shimStatus(env)).toMatchObject({ state: "foreign", foreignTarget: paths.shimPath });
    fs.rmSync(paths.shimPath);
    const real = path.join(root, "lib", "promptgraph", "cli.js");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    // A symlink to a file carrying the marker is still foreign: only a regular file can be ours.
    fs.writeFileSync(real, shimScript("/x"));
    fs.symlinkSync(real, paths.shimPath);
    expect(await shimStatus(env)).toMatchObject({ state: "foreign", foreignTarget: real });
    fs.unlinkSync(paths.shimPath);
    fs.symlinkSync("../missing/promptgraph", paths.shimPath);
    expect(await shimStatus(env)).toMatchObject({ state: "foreign", foreignTarget: path.join(env.HOME!, ".local", "missing", "promptgraph") });
    fs.unlinkSync(paths.shimPath);
    fs.writeFileSync(paths.shimPath, shimScript("/x"), { mode: 0o755 });
    expect(await shimStatus(env)).toMatchObject({ state: "ours", foreignTarget: null });
  });

  it("names the foreign target in the refusal only when it is elsewhere", () => {
    const status = (foreignTarget: string | null) => ({ path: "/h/.local/bin/promptgraph", state: "foreign" as const, foreignTarget, decision: null, onPath: null, shadowedBy: null, pathHint: null, warn: false });
    expect(new ShimExistsError(status("/h/.local/bin/promptgraph")).message).toBe("/h/.local/bin/promptgraph exists and was not installed by the promptgraph desktop app");
    expect(new ShimExistsError(status("/usr/lib/node_modules/promptgraph/cli.js")).message).toBe(
      "/h/.local/bin/promptgraph exists and was not installed by the promptgraph desktop app (→ /usr/lib/node_modules/promptgraph/cli.js)",
    );
  });

  it("never overwrites an entry that appears between the status and the write", async () => {
    const { env, paths } = setup();
    await expect(
      installShim(env, {
        replace: false,
        version: "0.2.0",
        pathCheck: okCheck,
        beforePublish: () => fs.writeFileSync(paths.shimPath, "#!/bin/sh\necho mine\n", { mode: 0o755 }),
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof ShimExistsError && err.status.state === "foreign");
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(fs.readdirSync(paths.binDir)).toEqual(["promptgraph"]);
    expect(readPrefs(paths.prefsFile).shim).toBeUndefined();
  });

  it("an ours shim that lost its marker meanwhile is not replaced", async () => {
    const { env, paths } = setup();
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.shimPath, shimScript("/old/target"), { mode: 0o755 });
    await expect(
      installShim(env, {
        replace: false,
        version: "0.2.0",
        pathCheck: okCheck,
        beforePublish: () => fs.writeFileSync(paths.shimPath, "#!/bin/sh\necho user edit\n"),
      }),
    ).rejects.toThrow(ShimExistsError);
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe("#!/bin/sh\necho user edit\n");
  });

  it("a foreign entry needs --replace, which keeps it under a free backup name", async () => {
    const { env, paths, root } = setup();
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.shimPath, "#!/bin/sh\necho v1\n", { mode: 0o755 });
    await expect(installShim(env, { replace: false, version: "0.2.0", pathCheck: okCheck })).rejects.toThrow(ShimExistsError);
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe("#!/bin/sh\necho v1\n");

    // promptgraph.bak is taken: the backup goes to .bak.1, and .bak is untouched.
    fs.writeFileSync(`${paths.shimPath}.bak`, "older backup\n");
    const replaced = await installShim(env, { replace: true, version: "0.2.0", pathCheck: okCheck });
    expect(replaced.backup).toBe(`${paths.shimPath}.bak.1`);
    expect(fs.readFileSync(`${paths.shimPath}.bak`, "utf8")).toBe("older backup\n");
    expect(fs.readFileSync(`${paths.shimPath}.bak.1`, "utf8")).toBe("#!/bin/sh\necho v1\n");
    expect(replaced.shim).toMatchObject({ state: "ours", decision: "accepted" });

    // A symlink entry is backed up as a symlink with the same target.
    const target = path.join(root, "npm-global", "bin", "promptgraph");
    fs.unlinkSync(paths.shimPath);
    fs.symlinkSync(target, paths.shimPath);
    const again = await installShim(env, { replace: true, version: "0.2.0", pathCheck: okCheck });
    expect(again.backup).toBe(`${paths.shimPath}.bak.2`);
    expect(fs.lstatSync(`${paths.shimPath}.bak.2`).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(`${paths.shimPath}.bak.2`)).toBe(target);
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe(shimScript(shimTarget(paths)));
  });

  it("uninstall removes only a marked file and records declined; decline touches nothing", async () => {
    const { env, paths } = setup();
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.shimPath, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
    expect((await uninstallShim(env, 7)).shim).toMatchObject({ state: "foreign", decision: "declined" });
    expect(fs.existsSync(paths.shimPath)).toBe(true);
    fs.rmSync(paths.shimPath);
    await installShim(env, { replace: false, version: "0.2.0", pathCheck: okCheck });
    expect((await uninstallShim(env, 8)).shim).toMatchObject({ state: "absent", decision: "declined" });
    expect(fs.existsSync(paths.shimPath)).toBe(false);
    expect((await declineShim(env, 9)).shim).toMatchObject({ state: "absent", decision: "declined" });
    expect(fs.existsSync(paths.shimPath)).toBe(false);
  });

  it("persists the decision in desktop.json (0600 in a 0700 directory), keeping unknown keys", async () => {
    const { env, paths } = setup();
    expect(paths.prefsFile).toBe(path.join(env.XDG_CONFIG_HOME!, "promptgraph", "desktop.json"));
    expect(readPrefs(paths.prefsFile)).toEqual({ v: 1 });
    writePrefs(paths.prefsFile, { v: 1, other: { keep: true } } as never);
    await declineShim(env, 1234);
    expect(fs.statSync(paths.prefsFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(paths.prefsFile)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(paths.prefsFile, "utf8"))).toEqual({ v: 1, other: { keep: true }, shim: { decision: "declined", decidedAt: 1234 } });
    expect((await shimStatus(env)).decision).toBe("declined");
    fs.writeFileSync(paths.prefsFile, "{garbage");
    expect(readPrefs(paths.prefsFile)).toEqual({ v: 1 });
  });

  it("desktop install rewrites a stale ours shim, records accepted when it has no decision, and leaves foreign ones alone", async () => {
    const { env, paths } = setup();
    fs.mkdirSync(paths.binDir, { recursive: true });
    const stale = shimScript("/old/data/promptgraph/runtime/current/bin/promptgraph");
    fs.writeFileSync(paths.shimPath, stale, { mode: 0o755 });
    const status = await refreshShim(env, { version: "0.2.0", now: 3, pathCheck: okCheck });
    expect(status).toMatchObject({ state: "ours", decision: "accepted", onPath: null, warn: false });
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe(shimScript(shimTarget(paths)));
    expect(fs.statSync(paths.shimPath).mode & 0o777).toBe(0o755);

    fs.writeFileSync(paths.shimPath, "#!/bin/sh\necho foreign\n");
    expect(await refreshShim(env, { version: "0.2.0", pathCheck: okCheck })).toMatchObject({ state: "foreign", decision: "accepted" });
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe("#!/bin/sh\necho foreign\n");
  });

  it("warns about PATH once per version, and desktop install re-checks while the last check failed", async () => {
    const { env, paths } = setup();
    let check: PathCheck = NOT_ON_PATH;
    const pc = async () => check;
    const first = await installShim(env, { replace: false, version: "0.2.0", pathCheck: pc });
    expect(first.shim).toMatchObject({ onPath: false, warn: true, pathHint: NOT_ON_PATH.pathHint });
    expect(readPrefs(paths.prefsFile).shim).toMatchObject({ decision: "accepted", pathOk: false, warnedVersion: "0.2.0" });
    // The next start (same version): checked again, not warned again.
    expect(await refreshShim(env, { version: "0.2.0", pathCheck: pc })).toMatchObject({ onPath: false, warn: false });
    // An update: warned once more.
    expect(await refreshShim(env, { version: "0.3.0", pathCheck: pc })).toMatchObject({ onPath: false, warn: true });
    expect(readPrefs(paths.prefsFile).shim?.warnedVersion).toBe("0.3.0");
    // Fixed: recorded OK, and no further checks.
    check = OK;
    expect(await refreshShim(env, { version: "0.3.0", pathCheck: pc })).toMatchObject({ onPath: true, warn: false, pathHint: null });
    expect(readPrefs(paths.prefsFile).shim?.pathOk).toBe(true);
    let called = false;
    expect(await refreshShim(env, { version: "0.4.0", pathCheck: async () => ((called = true), NOT_ON_PATH) })).toMatchObject({ onPath: null, warn: false });
    expect(called).toBe(false);
    // Shadowed by another promptgraph is a warning too.
    recordShimDecision(env, "accepted");
    const shadowed = await installShim(env, { replace: false, version: "0.5.0", pathCheck: async () => ({ onPath: true, shadowedBy: "/usr/local/bin/promptgraph", pathHint: "hint" }) });
    expect(shadowed.shim).toMatchObject({ onPath: true, shadowedBy: "/usr/local/bin/promptgraph", warn: true, pathHint: "hint" });
  });

  it("pathCheck reads the login shell's PATH (fake $SHELL) and finds shadowing commands", async () => {
    const { env, paths, root } = setup();
    fs.mkdirSync(paths.binDir, { recursive: true });
    const other = path.join(root, "usr-local-bin");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "promptgraph"), "#!/bin/sh\n", { mode: 0o755 });
    const linkDir = path.join(root, "bin-link");
    fs.symlinkSync(paths.binDir, linkDir);

    const withPath = (p: string) => ({ ...env, SHELL: fakeShell(root, p) });
    expect(await pathCheck(withPath(`/usr/bin:${paths.binDir}`))).toEqual({ onPath: true, shadowedBy: null, pathHint: null });
    // Entries are compared by realpath.
    expect(await pathCheck(withPath(`${linkDir}:/usr/bin`))).toEqual({ onPath: true, shadowedBy: null, pathHint: null });
    const notOn = await pathCheck(withPath("/usr/bin:/bin"));
    expect(notOn).toMatchObject({ onPath: false, shadowedBy: null });
    expect(notOn.pathHint).toContain("~/.profile");
    expect(await pathCheck(withPath(`${other}:${paths.binDir}`))).toMatchObject({ onPath: true, shadowedBy: path.join(other, "promptgraph") });
    // Later on PATH than the shim: not shadowing.
    expect(await pathCheck(withPath(`${paths.binDir}:${other}`))).toMatchObject({ onPath: true, shadowedBy: null });
    // No usable login shell: nothing is known.
    expect(await pathCheck({ ...env, SHELL: path.join(root, "missing-shell") }, { timeoutMs: 2000 })).toEqual({ onPath: null, shadowedBy: null, pathHint: null });
  });

  it("pathHintFor gives the line for the user's shell", () => {
    const { root } = setup();
    const home = path.join(root, "hint-home");
    fs.mkdirSync(home);
    const line = `'export PATH="$HOME/.local/bin:$PATH"'`;
    expect(pathHintFor("/usr/bin/zsh", home)).toBe(`echo ${line} >> ~/.zshrc`);
    expect(pathHintFor("fish", home)).toBe("fish_add_path ~/.local/bin");
    expect(pathHintFor("/bin/bash", home)).toMatch(new RegExp(`^echo ${line.replace(/[$.*+?^()|[\]\\]/g, "\\$&")} >> ~/\\.profile\\n\\(and add the same line to ~/\\.bashrc`));
    fs.writeFileSync(path.join(home, ".bash_profile"), "");
    expect(pathHintFor("bash", home).split("\n")[0]).toBe(`echo ${line} >> ~/.bash_profile`);
    expect(pathHintFor("bash", home)).toContain("~/.bashrc");
    expect(pathHintFor("/bin/dash", home).split("\n")[0]).toBe(`echo ${line} >> ~/.profile`);
  });

  it("refuses an unsafe ~/.local/bin (other-writable, group-writable by a shared group, or another owner)", async () => {
    const { env, paths } = setup();
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.chmodSync(paths.binDir, 0o757);
    await expect(installShim(env, { replace: false, version: "0.2.0", pathCheck: okCheck })).rejects.toThrow(ShimDirError);
    await expect(installShim(env, { replace: false, version: "0.2.0", pathCheck: okCheck })).rejects.toThrow(/writable by other users.*chmod o-w/);
    expect(fs.existsSync(paths.shimPath)).toBe(false);
    // Group-writable: accepted only for the user's private group (umask 002 under USERGROUPS_ENAB).
    fs.chmodSync(paths.binDir, 0o775);
    expect(() => checkBinDir(paths.binDir, undefined, () => false)).toThrow(/writable by its group .*chmod g-w/);
    expect(() => checkBinDir(paths.binDir, undefined, () => true)).not.toThrow();
    fs.chmodSync(paths.binDir, 0o755);
    expect(() => checkBinDir(paths.binDir, 12345)).toThrow(/belongs to another user/);
    expect(() => checkBinDir(paths.binDir)).not.toThrow();
    // Created 0755 when missing.
    const fresh = setup();
    checkBinDir(fresh.paths.binDir);
    expect(fs.statSync(fresh.paths.binDir).mode & 0o777).toBe(0o755);
  });

  it("isPrivateGroup follows the USERGROUPS convention of /etc/passwd and /etc/group", () => {
    const { root } = setup();
    const passwd = path.join(root, "passwd");
    const group = path.join(root, "group");
    fs.writeFileSync(passwd, "root:x:0:0::/root:/bin/sh\nana:x:1000:1000::/home/ana:/bin/zsh\nbob:x:1001:100::/home/bob:/bin/sh\n");
    const check = (groups: string, gid: number, uid = 1000) => isPrivateGroup(gid, uid, { passwd, group: (fs.writeFileSync(group, groups), group) });
    expect(check("ana:x:1000:\nusers:x:100:bob\n", 1000)).toBe(true);
    // A member listed, another name, not the primary group, or a group shared as another account's primary.
    expect(check("ana:x:1000:carl\n", 1000)).toBe(false);
    expect(check("devs:x:1000:\n", 1000)).toBe(false);
    expect(check("users:x:100:\n", 100)).toBe(false);
    expect(check("users:x:100:\n", 100, 1001)).toBe(false);
    fs.appendFileSync(passwd, "eve:x:1002:1000::/home/eve:/bin/sh\n");
    expect(check("ana:x:1000:\n", 1000)).toBe(false);
    // Unknown to the files (NSS only): not private.
    expect(isPrivateGroup(1000, 1000, { passwd: path.join(root, "missing"), group })).toBe(false);
  });

  it("`desktop shim install --json` on a foreign file prints the status and exits 1 with `exists`", async () => {
    const { env, paths, root } = setup();
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.shimPath, "#!/bin/sh\n", { mode: 0o755 });
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      paths: getPaths({ PG_HOME: path.join(root, "pg-home") }),
      env: { ...env, SHELL: fakeShell(root, `${paths.binDir}:/usr/bin`) },
      cwd: root,
      stdout: (l) => void out.push(l),
      stderr: (l) => void err.push(l),
      openBrowser: async () => undefined,
      now: () => 1,
      sleep: async () => undefined,
      serverCommand: [],
      version: "0.2.0",
      runtimeRoot: root,
    };
    const run = (...argv: string[]) => runDesktopShim(parseCliArgs(["desktop", "shim", ...argv, "--json"]), deps);
    expect(await run("install")).toBe(1);
    expect(ShimResultSchema.parse(JSON.parse(out[0]!)).shim).toMatchObject({ state: "foreign", foreignTarget: paths.shimPath });
    expect(err[0]).toMatch(/^error: .* exists/);
    out.length = 0;
    expect(await run("install", "--replace")).toBe(0);
    // The real PATH check through the fake login shell.
    expect(ShimResultSchema.parse(JSON.parse(out[0]!))).toMatchObject({ backup: `${paths.shimPath}.bak`, shim: { state: "ours", decision: "accepted", onPath: true, warn: false } });
    out.length = 0;
    expect(await run("status")).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ v: 1, shim: { state: "ours", onPath: null }, backup: null });
  });
});
