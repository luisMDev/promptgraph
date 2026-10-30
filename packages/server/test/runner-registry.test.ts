import { describe, expect, it } from "vitest";
import { getPaths } from "../src/config/paths.js";
import { EventBus } from "../src/events/bus.js";
import { HookRouter } from "../src/hooks/hook-router.js";
import { PtyManager } from "../src/pty/pty-manager.js";
import { ClaudeRunner } from "../src/runners/claude/claude-runner.js";
import { CommitRunner } from "../src/runners/git/commit-runner.js";
import { createRunnerRegistry } from "../src/runners/registry.js";
import { ShellRunner } from "../src/runners/shell-runner.js";
import type { LaneManager } from "../src/workspace/lane-manager.js";

describe("createRunnerRegistry", () => {
  it("maps the implemented node types", () => {
    const paths = getPaths({ PG_HOME: "/tmp/pg-registry" });
    const ptys = new PtyManager(new EventBus(), () => null);
    const claude = new ClaudeRunner({ ptys, hooks: new HookRouter(), paths, pgHookPath: "/x", endpoint: () => ({ port: 1, token: "t" }) });
    const reg = createRunnerRegistry({ claude, ptys, lanes: {} as LaneManager, paths });
    expect(reg.prompt).toBe(claude);
    expect(reg.command).toBe(claude);
    expect(reg.shell).toBeInstanceOf(ShellRunner);
    expect(reg.commit).toBeInstanceOf(CommitRunner);
    expect(reg.merge).toBeUndefined();
  });
});
