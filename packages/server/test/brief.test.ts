import { describe, expect, it, vi } from "vitest";
import type { BusEvents } from "../src/events/bus.js";
import { RunBriefer, type Summarize, type SummarizeInput } from "../src/engine/brief.js";
import { INTERRUPTED_BRIEF_ERROR, markInterrupted } from "../src/engine/recovery.js";
import { waitFor } from "./helpers.js";
import { allTypes, FakeRunner, makeGraph, setup, waitRun } from "./support/engine-fakes.js";

const usage = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.01, model: "haiku" };

function briefSetup(summarize: Summarize, runner = new FakeRunner()) {
  let briefer!: RunBriefer;
  const s = setup(allTypes(runner), {
    brief: (deps) => (briefer = new RunBriefer({ ...deps, env: {}, summarize, diffStat: async () => " a.ts | 2 +-" })),
  });
  const briefEvents: Array<BusEvents["brief:update"]> = [];
  s.bus.on("brief:update", (e) => briefEvents.push(e));
  return { s, briefer: () => briefer, briefEvents };
}

describe("run brief (§13.6)", () => {
  it("summarises each finished step and then the whole run, each call seeing the entries before it", async () => {
    const inputs: SummarizeInput[] = [];
    const summarize: Summarize = async (input) => {
      inputs.push(input);
      return { summary: { title: `Title ${inputs.length}`, summary: `Summary ${inputs.length}` }, usage };
    };
    const { s, briefer, briefEvents } = briefSetup(summarize);
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b", type: "shell" }], [["a", "b"]], { brief: { enabled: true, model: "sonnet" } }));

    const detail = await s.engine.startRun("flow");
    await waitRun(s, detail.run.id, "succeeded");
    await waitFor(() => s.store.listBriefEntries(detail.run.id).length === 3 && s.store.listBriefEntries(detail.run.id).every((e) => e.status !== "pending"), 3000);
    await briefer().idle(detail.run.id);

    const entries = s.store.listBriefEntries(detail.run.id);
    expect(entries.map((e) => [e.kind, e.nodeId, e.outcome, e.status, e.title])).toEqual([
      ["node", "a", "succeeded", "ready", "Title 1"],
      ["node", "b", "succeeded", "ready", "Title 2"],
      ["run", null, "succeeded", "ready", "Title 3"],
    ]);
    expect(inputs.map((i) => i.model)).toEqual(["sonnet", "sonnet", "sonnet"]);
    expect(inputs[0]!.cwd).toBe(s.graphs.repoPath);
    expect(inputs[0]!.prompt).toContain("Instructions:\ndo it");
    expect(inputs[0]!.prompt).toContain("out:a");
    expect(inputs[0]!.prompt).toContain("(nothing yet: this is the first entry)");
    expect(inputs[1]!.prompt).toContain("1. Title 1 (succeeded)\nSummary 1");
    expect(inputs[1]!.prompt).toContain("$ true");
    expect(inputs[2]!.prompt).toContain("The run ended: succeeded.");
    expect(inputs[2]!.prompt).toContain("2. Title 2 (succeeded)");

    // The summaries' own usage counts in the run's cost; the detail carries the brief.
    expect(s.store.getRunSummary(detail.run.id)!.usage.costUsd).toBeCloseTo(0.03);
    expect(s.engine.getRun(detail.run.id).brief).toHaveLength(3);
    // Every entry is announced pending, then ready.
    expect(briefEvents.filter((e) => e.entry.id === entries[0]!.id).map((e) => e.entry.status)).toEqual(["pending", "ready"]);
    expect(briefEvents.every((e) => e.repoId === "repo-0123abcd")).toBe(true);
  });

  it("does nothing when the graph has the brief off (the default)", async () => {
    const summarize = vi.fn<Summarize>();
    const { s } = briefSetup(summarize);
    s.graphs.save(makeGraph([{ id: "a" }], []));
    const detail = await s.engine.startRun("flow");
    await waitRun(s, detail.run.id, "succeeded");
    expect(s.store.listBriefEntries(detail.run.id)).toEqual([]);
    expect(s.engine.getRun(detail.run.id).brief).toEqual([]);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("marks an entry failed when the call fails, without affecting the run; failed steps are summarised too", async () => {
    const summarize: Summarize = async (input) => {
      if (input.prompt.includes("result: failed")) throw new Error("claude -p timed out");
      return { summary: { title: "ok", summary: "fine" }, usage: null };
    };
    const runner = new FakeRunner((e) => queueMicrotask(() => (e.ctx.node.id === "b" ? e.failWith("tests failed") : e.succeed())));
    const { s, briefer } = briefSetup(summarize, runner);
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b", onError: "fail-run" }], [["a", "b"]], { brief: { enabled: true } }));

    const detail = await s.engine.startRun("flow");
    await waitRun(s, detail.run.id, "failed");
    await waitFor(() => s.store.listBriefEntries(detail.run.id).length === 3, 3000);
    await briefer().idle(detail.run.id);
    const entries = s.store.listBriefEntries(detail.run.id);
    expect(entries.map((e) => [e.kind, e.outcome, e.status, e.error])).toEqual([
      ["node", "succeeded", "ready", null],
      ["node", "failed", "failed", "claude -p timed out"],
      ["run", "failed", "ready", null],
    ]);
  });

  it("stops on shutdown and leaves no entry pending after a restart", async () => {
    let release!: () => void;
    const summarize: Summarize = (input) =>
      new Promise((resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("aborted")));
        release = () => resolve({ summary: { title: "t", summary: "s" }, usage: null });
      });
    const { s, briefer } = briefSetup(summarize);
    s.graphs.save(makeGraph([{ id: "a" }], [], { brief: { enabled: true } }));
    const detail = await s.engine.startRun("flow");
    await waitRun(s, detail.run.id, "succeeded");
    await waitFor(() => release !== undefined, 3000);
    await briefer().shutdown();
    const entries = s.store.listBriefEntries(detail.run.id);
    expect(entries.map((e) => [e.kind, e.status, e.error])).toEqual([
      ["node", "failed", INTERRUPTED_BRIEF_ERROR],
      ["run", "failed", INTERRUPTED_BRIEF_ERROR],
    ]);

    // A daemon killed mid-summary leaves pending rows: the next start marks them failed.
    const run = s.store.listRuns({ repoPath: s.graphs.repoPath, limit: 1 })[0]!;
    const pending = s.store.insertBriefEntry({ runId: run.id, kind: "run", nodeRunId: null, nodeId: null, outcome: "succeeded" });
    markInterrupted(s.store, {});
    expect(s.store.getBriefEntry(pending.id)).toMatchObject({ status: "failed", error: INTERRUPTED_BRIEF_ERROR });
  });

  it("goes away with its run", async () => {
    const { s, briefer } = briefSetup(async () => ({ summary: { title: "t", summary: "s" }, usage: null }));
    s.graphs.save(makeGraph([{ id: "a" }], [], { brief: { enabled: true } }));
    const detail = await s.engine.startRun("flow");
    await waitRun(s, detail.run.id, "succeeded");
    await waitFor(() => s.store.listBriefEntries(detail.run.id).length === 2, 3000);
    await briefer().idle(detail.run.id);
    await s.engine.deleteRun(detail.run.id);
    expect(s.store.listBriefEntries(detail.run.id)).toEqual([]);
  });
});
