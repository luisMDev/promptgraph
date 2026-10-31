import { describe, expect, it } from "vitest";
import { ApprovalRunner } from "../src/runners/approval-runner.js";
import { makeCtx, makeLane, makeRun } from "./support/runner-ctx.js";

function start() {
  const run = makeRun({ nodes: [{ id: "a", type: "approval", label: "Review", config: { message: "Ship?" } } as never] });
  const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane("/tmp") });
  const exec = new ApprovalRunner().start(ctx);
  return { ctx, exec };
}

describe("ApprovalRunner", () => {
  it("waits for approval and outputs the decision", async () => {
    const { ctx, exec } = start();
    expect(ctx.current.status).toBe("waiting_approval");
    exec.controls.approve!({ approved: true, comment: " looks good " });
    expect(await exec.result).toEqual({ status: "succeeded", output: { approved: true, comment: "looks good" } });
  });

  it("fails on rejection, keeping the comment", async () => {
    const { exec } = start();
    exec.controls.approve!({ approved: false, comment: "needs tests" });
    expect(await exec.result).toEqual({
      status: "failed",
      error: "Approval rejected: needs tests",
      output: { approved: false, comment: "needs tests" },
    });
  });

  it("Done approves without a comment; the first decision wins", async () => {
    const { exec } = start();
    exec.controls.done();
    exec.controls.approve!({ approved: false });
    expect(await exec.result).toEqual({ status: "succeeded", output: { approved: true } });
  });

  it("fail() fails with the reason, cancel and run abort cancel", async () => {
    const failed = start();
    failed.exec.controls.fail("not now");
    expect(await failed.exec.result).toEqual({ status: "failed", error: "not now" });

    const cancelled = start();
    await cancelled.exec.controls.cancel();
    expect(await cancelled.exec.result).toEqual({ status: "cancelled" });

    const aborted = start();
    aborted.ctx.abort.abort();
    expect(await aborted.exec.result).toEqual({ status: "cancelled" });
  });
});
