import { spawn } from "node:child_process";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { runStop, STOP_TIMEOUT_MS } from "../src/cli/commands/stop.js";
import { formatDuration, formatTable, type CliDeps } from "../src/cli/deps.js";
import { daemonInfoPath, writeDaemonInfo } from "../src/config/daemon-info.js";
import { getPaths } from "../src/config/paths.js";
import { VERSION } from "../src/config/version.js";
import { isProcessAlive, processStartTime } from "../src/util/process.js";
import { tempDir, waitFor } from "./helpers.js";

/** CLI commands with injected deps (no child process for the CLI itself). */
describe("cli commands", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  function deps(): CliDeps & { out: string[]; err: string[]; clock: { t: number } } {
    const t = tempDir("pg-cli-cmd-");
    cleanups.push(t.cleanup);
    const env = { ...process.env, PG_HOME: `${t.dir}/pg-home` };
    const out: string[] = [];
    const err: string[] = [];
    const clock = { t: 1_000_000 };
    return {
      paths: getPaths(env),
      env,
      cwd: t.dir,
      stdout: (l) => void out.push(l),
      stderr: (l) => void err.push(l),
      openBrowser: async () => {
        throw new Error("no browser in tests");
      },
      now: () => clock.t,
      // Virtual time: every poll advances the clock by one second.
      sleep: async () => {
        clock.t += 1000;
      },
      serverCommand: [],
      version: VERSION,
      out,
      err,
      clock,
    };
  }

  it("stop prints progress every 5 s and gives up after 30 s on a process that ignores SIGTERM", async () => {
    const d = deps();
    // A process we own that ignores SIGTERM, recorded with its real start time (a matching identity).
    const stubborn = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
    cleanups.push(() => void stubborn.kill("SIGKILL"));
    const pid = stubborn.pid!;
    const pidStart = await waitFor(() => processStartTime(pid), 5_000);
    writeDaemonInfo(d.paths, { version: 2, pid, pidStart, port: 1, serverVersion: "0.0.0-other", startedAt: Date.now() });
    // Give sh time to install its trap before the signal.
    await new Promise((r) => setTimeout(r, 200));

    const code = await runStop(parseCliArgs(["stop"]), d);
    expect(code).toBe(1);
    expect(d.out[0]).toBe(`Stopping promptgraph (pid ${pid}): running steps are interrupted and their runs stay resumable…`);
    expect(d.out.slice(1)).toEqual([5, 10, 15, 20, 25].map((s) => `Still stopping (pid ${pid}, ${s} s)…`));
    expect(d.err).toEqual([expect.stringContaining(`error: promptgraph (pid ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s`)]);
    expect(isProcessAlive(pid)).toBe(true);
    // Not stopped: the record stays.
    expect(fs.existsSync(daemonInfoPath(d.paths))).toBe(true);
  });

  it("stop without a record reports not running", async () => {
    const d = deps();
    expect(await runStop(parseCliArgs(["stop"]), d)).toBe(1);
    expect(d.out).toEqual(["promptgraph is not running"]);
  });

  it("formats tables and durations", () => {
    expect(formatTable([["A", "BB", "C"], ["aaa", "b", ""]])).toEqual(["A    BB  C", "aaa  b"]);
    expect(formatDuration(12_500)).toBe("12s");
    expect(formatDuration(250_000)).toBe("4m 10s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
  });
});
