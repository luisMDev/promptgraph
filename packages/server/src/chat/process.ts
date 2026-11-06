import { spawn } from "node:child_process";

/** What the chat needs from a child process; tests inject a fake (never the real `claude`). */
export interface ChatChild {
  readonly pid: number | undefined;
  /** Writes one line (a newline is appended). False once stdin is closed. */
  writeLine(line: string): boolean;
  /** Closes stdin (Claude Code exits after the current turn). */
  endInput(): void;
  kill(signal?: NodeJS.Signals): void;
  onStdout(listener: (chunk: Buffer | string) => void): void;
  onStderr(listener: (chunk: Buffer | string) => void): void;
  /** Called once: on exit, or on a spawn error (code null, `error` set). */
  onExit(listener: (exit: ChatChildExit) => void): void;
}

export interface ChatChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface ChatSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type ChatSpawner = (spec: ChatSpawnSpec) => ChatChild;

/** Real spawner: child_process with pipes, no PTY (DESIGN §21.1). */
export const spawnChatProcess: ChatSpawner = (spec) => {
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdinOpen = true;
  child.stdin.on("error", () => (stdinOpen = false));
  child.stdin.on("close", () => (stdinOpen = false));
  const exitListeners: Array<(exit: ChatChildExit) => void> = [];
  let exited = false;
  const finish = (exit: ChatChildExit) => {
    if (exited) return;
    exited = true;
    stdinOpen = false;
    for (const l of exitListeners) l(exit);
  };
  child.on("error", (error) => {
    // A spawn failure never emits "close"; an error after spawn (kill failed) is followed by "close".
    if (child.pid === undefined) finish({ code: null, signal: null, error });
  });
  child.on("close", (code, signal) => finish({ code, signal }));
  return {
    get pid() {
      return child.pid;
    },
    writeLine(line) {
      if (!stdinOpen) return false;
      child.stdin.write(`${line}\n`);
      return true;
    },
    endInput() {
      if (!stdinOpen) return;
      stdinOpen = false;
      child.stdin.end();
    },
    kill(signal = "SIGTERM") {
      if (!exited) child.kill(signal);
    },
    onStdout: (l) => void child.stdout.on("data", l),
    onStderr: (l) => void child.stderr.on("data", l),
    onExit: (l) => void exitListeners.push(l),
  };
};
