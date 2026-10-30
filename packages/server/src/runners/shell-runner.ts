import type { GraphNodeOf } from "@promptgraph/shared";
import { childEnv } from "../config/child-env.js";
import { ptyLogPath, type PgPaths } from "../config/paths.js";
import type { PtyHandle, PtyManager } from "../pty/pty-manager.js";
import { stripAnsi, tailLines, errorMessage } from "../util/text.js";
import type { NodeExecution, Runner, RunnerContext, RunnerResult } from "./types.js";

/** Lines of output kept in output.stdoutTail (§6.1). */
export const SHELL_TAIL_LINES = 200;

/** Raw output kept in memory to compute the tail (200 lines rarely exceed this). */
const TAIL_BUFFER_CHARS = 256 * 1024;
const KILL_WAIT_MS = 2000;

export interface ShellRunnerDeps {
  ptys: PtyManager;
  paths: PgPaths;
  /** Base env for childEnv; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

type Ending = { kind: "timeout" } | { kind: "failed"; reason: string } | { kind: "cancelled" };

/**
 * shell nodes: `sh -c <run>` in a PTY (id = nodeRun.id, viewable live) in the lane worktree with
 * childEnv(config.env). Exit 0 → succeeded; else failed. Timeout (timeoutSec) → kill, failed, timedOut.
 * Output: {exitCode, stdoutTail (ANSI-stripped last 200 lines), timedOut?}.
 */
export class ShellRunner implements Runner {
  constructor(private readonly deps: ShellRunnerDeps) {}

  start(ctx: RunnerContext): NodeExecution {
    const node = ctx.node as GraphNodeOf<"shell">;
    if (node.type !== "shell") throw new Error(`ShellRunner cannot run ${ctx.node.type} nodes`);
    const { run, nodeRun, lane } = ctx;
    let handle: PtyHandle;
    try {
      handle = this.deps.ptys.spawn({
        id: nodeRun.id,
        file: "sh",
        args: ["-c", node.config.run],
        cwd: lane.worktreePath,
        env: childEnv(node.config.env ?? {}, this.deps.env ?? process.env),
        logPath: ptyLogPath(this.deps.paths, run.id, nodeRun.id),
      });
    } catch (err) {
      const error = `Could not start the shell: ${errorMessage(err)}`;
      const noop = () => undefined;
      return { result: Promise.resolve({ status: "failed", error }), controls: { done: noop, fail: noop, setHold: noop, cancel: async () => undefined } };
    }
    ctx.update({ ptyId: handle.id });

    let raw = "";
    handle.onData((chunk) => {
      raw = (raw + chunk.toString("utf8")).slice(-TAIL_BUFFER_CHARS);
    });

    let ending: Ending | null = null;
    const end = (e: Ending) => {
      if (ending) return;
      ending = e;
      void killGracefully(handle);
    };
    const timer = node.config.timeoutSec ? setTimeout(() => end({ kind: "timeout" }), node.config.timeoutSec * 1000) : null;
    const onAbort = () => end({ kind: "cancelled" });
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });

    const result = handle.exited.then((exit): RunnerResult => {
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      const final = ending as Ending | null;
      if (final?.kind === "cancelled") return { status: "cancelled" };
      const stdoutTail = tailLines(stripAnsi(raw), SHELL_TAIL_LINES);
      if (final?.kind === "timeout") {
        return {
          status: "failed",
          error: `Timed out after ${node.config.timeoutSec}s`,
          output: { exitCode: null, stdoutTail, timedOut: true },
        };
      }
      const output = { exitCode: exit.code, stdoutTail };
      if (final?.kind === "failed") return { status: "failed", error: final.reason, output };
      if (exit.code === 0) return { status: "succeeded", output };
      return { status: "failed", error: `Exited with code ${exit.code ?? `signal ${exit.signal}`}`, output };
    });

    return {
      result,
      controls: {
        // Done/Hold have no meaning for a shell command: it finishes with its exit code.
        done: () => undefined,
        setHold: () => undefined,
        fail: (reason) => end({ kind: "failed", reason: reason || "Marked as failed by the user" }),
        cancel: async () => {
          end({ kind: "cancelled" });
          await result;
        },
      },
    };
  }
}

async function killGracefully(handle: PtyHandle): Promise<void> {
  handle.kill("SIGTERM");
  const timer = setTimeout(() => handle.kill("SIGKILL"), KILL_WAIT_MS);
  await handle.exited;
  clearTimeout(timer);
}
