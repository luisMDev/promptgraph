import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonInfo, ServerInfo } from "@promptgraph/shared";
import {
  daemonInfoPath,
  daemonLogPath,
  findLegacyServers,
  portFilePath,
  readDaemonInfo,
  readStickyPort,
  removeDaemonInfo,
  removeStaleLegacy,
  rotateDaemonLog,
  writeDaemonInfo,
  writeStickyPort,
} from "../src/config/daemon-info.js";
import { getPaths, type PgPaths } from "../src/config/paths.js";
import { isSameProcess, processCmdline, processStartTime } from "../src/util/process.js";
import { tempDir, waitFor } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(): { dir: string; paths: PgPaths } {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return { dir: t.dir, paths: getPaths({ PG_HOME: path.join(t.dir, "pg-home") }) };
}

/** Pid of a process that has exited (and been reaped). */
function deadPid(): number {
  const res = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(res.stdout.trim());
}

const ownStart = () => processStartTime(process.pid)!;

const record = (patch: Partial<DaemonInfo> = {}): DaemonInfo => ({
  version: 2,
  pid: process.pid,
  pidStart: ownStart(),
  port: 4777,
  serverVersion: "0.1.0",
  startedAt: 1,
  ...patch,
});

describe("process identity", () => {
  it("reads the start time of a live process and null for a dead one", () => {
    const start = processStartTime(process.pid);
    expect(start).toEqual(expect.any(Number));
    expect(processStartTime(process.pid)).toBe(start);
    expect(isSameProcess(process.pid, start!)).toBe(true);
    expect(isSameProcess(process.pid, start! + 1)).toBe(false);
    expect(processStartTime(deadPid())).toBeNull();
    expect(processStartTime(0)).toBeNull();
    expect(processStartTime(-5)).toBeNull();
  });

  it("parses the fields after the last ')' even when the command name contains parentheses and spaces", async () => {
    const { dir } = setup();
    const exe = path.join(dir, "a) 1 2 (b");
    fs.copyFileSync("/bin/sleep", exe);
    fs.chmodSync(exe, 0o755);
    const child = spawn(exe, ["5"], { stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    await waitFor(() => fs.readFileSync(`/proc/${child.pid}/stat`, "utf8").includes("a) 1 2 (b"));
    const start = processStartTime(child.pid!);
    expect(start).toEqual(expect.any(Number));
    // The child started after this process.
    expect(start!).toBeGreaterThanOrEqual(ownStart());
  });
});

describe("daemon record (DESIGN §11.3)", () => {
  it("round-trips with mode 0600 and is removed only by its own pid", () => {
    const { paths } = setup();
    const info = record();
    writeDaemonInfo(paths, info);
    expect(fs.statSync(daemonInfoPath(paths)).mode & 0o777).toBe(0o600);
    expect(readDaemonInfo(paths)).toEqual(info);
    removeDaemonInfo(paths, process.pid + 1);
    expect(fs.existsSync(daemonInfoPath(paths))).toBe(true);
    removeDaemonInfo(paths);
    expect(fs.existsSync(daemonInfoPath(paths))).toBe(false);
    expect(readDaemonInfo(paths)).toBeNull();
  });

  it("is stale when its pid is dead or that pid started at another time (pid reuse)", () => {
    const { paths } = setup();
    writeDaemonInfo(paths, record({ pid: deadPid() }));
    expect(readDaemonInfo(paths)).toBeNull();
    writeDaemonInfo(paths, record({ pidStart: ownStart() + 1 }));
    expect(readDaemonInfo(paths)).toBeNull();
    fs.writeFileSync(daemonInfoPath(paths), "{ not json");
    expect(readDaemonInfo(paths)).toBeNull();
    fs.writeFileSync(daemonInfoPath(paths), JSON.stringify({ ...record(), version: 1 }));
    expect(readDaemonInfo(paths)).toBeNull();
  });

  it("reads and writes the sticky port", () => {
    const { paths } = setup();
    expect(readStickyPort(paths)).toBeNull();
    writeStickyPort(paths, 4781);
    expect(readStickyPort(paths)).toBe(4781);
    expect(fs.statSync(portFilePath(paths)).mode & 0o777).toBe(0o600);
    for (const bad of ["", "abc", "0", "70000", "47.5"]) {
      fs.writeFileSync(portFilePath(paths), bad);
      expect(readStickyPort(paths), bad).toBeNull();
    }
  });

  it("rotates daemon.log above the threshold only", () => {
    const { paths } = setup();
    const log = daemonLogPath(paths);
    expect(rotateDaemonLog(paths, 10)).toBe(false);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, "0123456789");
    expect(rotateDaemonLog(paths, 10)).toBe(false);
    expect(fs.existsSync(log)).toBe(true);
    fs.writeFileSync(`${log}.1`, "older");
    fs.appendFileSync(log, "x");
    expect(rotateDaemonLog(paths, 10)).toBe(true);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readFileSync(`${log}.1`, "utf8")).toBe("0123456789x");
  });
});

describe("legacy per-repository servers (DESIGN §4.4)", () => {
  function writeLegacy(paths: PgPaths, name: string, content: ServerInfo | string): string {
    const file = path.join(paths.home, "servers", `${name}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    return file;
  }
  const legacy = (pid: number, repoPath: string, startedAt: number = Date.now()): ServerInfo => ({
    version: 1,
    pid,
    repoPath,
    port: 1234,
    token: "t",
    serverVersion: "0.0.9",
    startedAt,
  });

  /** A live child process running the given argv (exec done); killed after the test. */
  async function liveChild(cmd: string, args: string[]): Promise<number> {
    const child = spawn(cmd, args, { stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    const pid = child.pid!;
    await waitFor(() => processCmdline(pid)?.endsWith(args.join(" ")));
    return pid;
  }

  it("finds only live records and removes only dead ones", () => {
    const { paths } = setup();
    expect(findLegacyServers(paths)).toEqual([]);
    expect(removeStaleLegacy(paths)).toEqual([]);
    const live = writeLegacy(paths, "live", legacy(process.pid, "/repo/live"));
    const dead = writeLegacy(paths, "dead", legacy(deadPid(), "/repo/dead"));
    const junk = writeLegacy(paths, "junk", "{ nope");
    expect(findLegacyServers(paths).map((s) => s.repoPath)).toEqual(["/repo/live"]);
    expect(removeStaleLegacy(paths)).toEqual([dead]);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(junk)).toBe(true);
  });

  it("reports a record whose pid was reused by a process started after it as stale", async () => {
    const { paths } = setup();
    const writtenAt = Date.now() - 10 * 60_000; // the crashed server wrote it 10 minutes ago
    const reused = await liveChild("sleep", ["30"]);
    const stale = writeLegacy(paths, "reused", legacy(reused, "/repo/reused", writtenAt));
    // A process started before its record was written is the server itself.
    const own = writeLegacy(paths, "own", legacy(reused, "/repo/own", Date.now() + 1000));
    // A later start whose command line is promptgraph's is kept (the wall clock may have moved).
    const named = await liveChild(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "promptgraph"]);
    const kept = writeLegacy(paths, "named", legacy(named, "/repo/named", writtenAt));
    expect(findLegacyServers(paths).map((s) => s.repoPath).sort()).toEqual(["/repo/named", "/repo/own"]);
    expect(removeStaleLegacy(paths)).toEqual([stale]);
    expect(fs.existsSync(own)).toBe(true);
    expect(fs.existsSync(kept)).toBe(true);
  });
});
