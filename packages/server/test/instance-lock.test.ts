import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonLockName, daemonPidPath, DaemonLock, isDaemonLock, LegacyRepoLocks, namedLockName, SocketLock, withSocketLock } from "../src/config/instance-lock.js";
import { acquirePreM7Lock } from "./support/legacy-lock.js";
import { getPaths, type PgPaths } from "../src/config/paths.js";
import { repoKey } from "../src/config/repo-key.js";
import { tempDir } from "./helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(): PgPaths {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return getPaths({ PG_HOME: path.join(t.dir, "pg-home") });
}

async function acquire(paths: PgPaths) {
  const result = await DaemonLock.acquire(paths);
  if (isDaemonLock(result)) cleanups.push(() => result.release());
  return result;
}

describe("DaemonLock (DESIGN §4.1 item 1)", () => {
  it("uses an abstract socket named after the uid and the realpath of PG_HOME", () => {
    const paths = setup();
    const name = daemonLockName(paths);
    expect(name.startsWith("\0promptgraph-")).toBe(true);
    expect(name).toMatch(new RegExp(`^\\0promptgraph-${process.getuid!()}-[0-9a-f]{16}$`));
    // A symlink to the same home is the same lock.
    const link = `${paths.home}-link`;
    fs.symlinkSync(paths.home, link);
    expect(daemonLockName({ ...paths, home: link })).toBe(name);
    expect(daemonLockName(setup())).not.toBe(name);
  });

  it("two concurrent acquires in one PG_HOME give exactly one winner", async () => {
    const paths = setup();
    const results = await Promise.all([acquire(paths), acquire(paths)]);
    const winners = results.filter(isDaemonLock);
    expect(winners).toHaveLength(1);
    expect(results.find((r) => !isDaemonLock(r))).toEqual({ heldBy: process.pid });
    expect(fs.readFileSync(daemonPidPath(paths), "utf8")).toBe(`${process.pid}\n`);
    expect(fs.statSync(daemonPidPath(paths)).mode & 0o777).toBe(0o600);
  });

  it("release lets a new acquire succeed", async () => {
    const paths = setup();
    const first = await acquire(paths);
    expect(isDaemonLock(first)).toBe(true);
    await (first as DaemonLock).release();
    expect(fs.existsSync(daemonPidPath(paths))).toBe(false);
    expect(isDaemonLock(await acquire(paths))).toBe(true);
  });

  it("isHeld probes the lock without taking it or touching locks/daemon.pid", async () => {
    const paths = setup();
    expect(await DaemonLock.isHeld(paths)).toBe(false);
    expect(fs.existsSync(daemonPidPath(paths))).toBe(false);
    const lock = await acquire(paths);
    expect(await DaemonLock.isHeld(paths)).toBe(true);
    await (lock as DaemonLock).release();
    expect(await DaemonLock.isHeld(paths)).toBe(false);
    expect(isDaemonLock(await acquire(paths))).toBe(true);
  });

  it("a locks/daemon.pid naming a live unrelated process does not block acquire", async () => {
    const paths = setup();
    fs.mkdirSync(path.dirname(daemonPidPath(paths)), { recursive: true });
    fs.writeFileSync(daemonPidPath(paths), `${process.ppid}\n`);
    expect(isDaemonLock(await acquire(paths))).toBe(true);
    expect(fs.readFileSync(daemonPidPath(paths), "utf8")).toBe(`${process.pid}\n`);
  });

  it("the kernel releases the lock of a process that is SIGKILLed", async () => {
    const paths = setup();
    // The child listens on the same abstract name (argv cannot carry the leading NUL).
    const script = `require("node:net").createServer().listen("\\0" + process.argv[1], () => console.log("ready"));`;
    const child = spawn(process.execPath, ["-e", script, daemonLockName(paths).slice(1)], { stdio: ["ignore", "pipe", "inherit"] });
    cleanups.push(() => void child.kill("SIGKILL"));
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on("data", (d: Buffer) => d.toString().includes("ready") && resolve());
      child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
    });
    fs.mkdirSync(path.dirname(daemonPidPath(paths)), { recursive: true });
    fs.writeFileSync(daemonPidPath(paths), `${child.pid}\n`);
    expect(await acquire(paths)).toEqual({ heldBy: child.pid });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect(isDaemonLock(await acquire(paths))).toBe(true);
  });
});

describe("LegacyRepoLocks (DESIGN §4.4)", () => {
  it("makes a pre-M7 per-repository start fail with 'already running' until released", () => {
    const paths = setup();
    const locks = new LegacyRepoLocks(paths);
    locks.hold("/repo/a");
    locks.hold("/repo/a"); // idempotent
    locks.hold("/repo/b");
    const file = path.join(paths.home, "locks", `${repoKey("/repo/a")}.pid`);
    expect(fs.readFileSync(file, "utf8")).toBe(`${process.pid}\n/repo/a\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // acquirePreM7Lock is exactly the pre-M7 lock logic.
    expect(() => acquirePreM7Lock(paths, "/repo/a")).toThrow(/already running/);
    locks.release("/repo/a");
    expect(fs.existsSync(file)).toBe(false);
    const old = acquirePreM7Lock(paths, "/repo/a");
    old.release();
    expect(() => acquirePreM7Lock(paths, "/repo/b")).toThrow(/already running/);
    locks.releaseAll();
    acquirePreM7Lock(paths, "/repo/b").release();
  });

  it("refuses a repository whose lock a live pre-M7 server of another process holds, and never removes it", () => {
    const paths = setup();
    const file = path.join(paths.home, "locks", `${repoKey("/repo/a")}.pid`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${process.ppid}\n/repo/a\n`);
    const locks = new LegacyRepoLocks(paths);
    expect(() => locks.hold("/repo/a")).toThrow(`stop the promptgraph server for /repo/a (pid ${process.ppid}) first`);
    locks.release("/repo/a");
    expect(fs.readFileSync(file, "utf8")).toBe(`${process.ppid}\n/repo/a\n`);
  });

  it("takes over a stale lock file (dead owner)", () => {
    const paths = setup();
    const file = path.join(paths.home, "locks", `${repoKey("/repo/a")}.pid`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${deadPid()}\n/repo/a\n`);
    const locks = new LegacyRepoLocks(paths);
    locks.hold("/repo/a");
    expect(fs.readFileSync(file, "utf8")).toBe(`${process.pid}\n/repo/a\n`);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    locks.releaseAll();
  });

  it("never replaces a live lock written between its check and its takeover of a stale one", () => {
    const paths = setup();
    const file = path.join(paths.home, "locks", `${repoKey("/repo/a")}.pid`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${deadPid()}\n/repo/a\n`);
    const live = `${process.ppid}\n/repo/a\n`;
    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // An old per-repository binary takes the stale lock (rm + wx) right before the daemon moves it.
      if (from === file) {
        fs.rmSync(file);
        fs.writeFileSync(file, live, { flag: "wx" });
      }
      realRename(from, to);
    });
    try {
      const locks = new LegacyRepoLocks(paths);
      expect(() => locks.hold("/repo/a")).toThrow(`stop the promptgraph server for /repo/a (pid ${process.ppid}) first`);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(file, "utf8")).toBe(live);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });
});

describe("SocketLock (named abstract-socket locks, shared by the daemon and the desktop runtime)", () => {
  it("names a lock by kind, uid and the realpath of a directory", () => {
    const paths = setup();
    fs.mkdirSync(paths.home, { recursive: true });
    const link = `${paths.home}-link`;
    fs.symlinkSync(paths.home, link);
    cleanups.push(() => fs.unlinkSync(link));
    expect(namedLockName("runtime", paths.home)).toBe(namedLockName("runtime", link));
    expect(namedLockName("runtime", paths.home)).toMatch(/^\0promptgraph-runtime-\d+-[0-9a-f]{16}$/);
    expect(namedLockName(null, paths.home)).toBe(daemonLockName(paths));
  });

  it("serialises holders and times out while held", async () => {
    const paths = setup();
    fs.mkdirSync(paths.home, { recursive: true });
    const name = namedLockName("test", paths.home);
    const held = await SocketLock.tryAcquire(name);
    expect(held).not.toBeNull();
    expect(await SocketLock.tryAcquire(name)).toBeNull();
    expect(await SocketLock.isHeld(name)).toBe(true);
    await expect(SocketLock.acquire(name, { timeoutMs: 150, pollMs: 20, what: "the test lock" })).rejects.toThrow("the test lock is held by another process");
    await held!.release();
    expect(await SocketLock.isHeld(name)).toBe(false);
    const order: string[] = [];
    await Promise.all(
      ["a", "b", "c"].map((id) =>
        withSocketLock(name, { timeoutMs: 5000 }, async () => {
          order.push(`${id}+`);
          await new Promise((r) => setTimeout(r, 30));
          order.push(`${id}-`);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2) expect(order[i]!.slice(0, 1)).toBe(order[i + 1]!.slice(0, 1));
  });
});

/** A pid that is not running: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}
