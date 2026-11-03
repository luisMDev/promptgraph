// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/rest";
import { nodeRunOf } from "../../test-fixtures";
import { GraceCountdown, graceSecondsLeft } from "./GraceCountdown";

describe("GraceCountdown (§7.4)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("counts whole seconds left only while the node runs", () => {
    const running = nodeRunOf({ id: "n", nodeId: "a", status: "running", graceUntil: 10_000 });
    expect(graceSecondsLeft(running, 5_001)).toBe(5);
    expect(graceSecondsLeft(running, 9_999)).toBe(1);
    expect(graceSecondsLeft(running, 10_000)).toBeNull();
    expect(graceSecondsLeft({ ...running, status: "idle" }, 5_000)).toBeNull();
    expect(graceSecondsLeft({ ...running, graceUntil: null }, 5_000)).toBeNull();
  });

  it("shows the countdown and holds the node", () => {
    const nodeRun = nodeRunOf({ id: "n", nodeId: "a", status: "running", graceUntil: Date.now() + 4_500 });
    const hold = vi.spyOn(api, "holdNode").mockResolvedValue({ nodeRun: { ...nodeRun, hold: true } });
    render(<GraceCountdown nodeRun={nodeRun} />);
    expect(screen.getByRole("status").textContent).toMatch(/Auto-continuing in 5s/);
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    expect(hold).toHaveBeenCalledWith("n", true);
  });

  it("renders nothing without a countdown", () => {
    const { container } = render(<GraceCountdown nodeRun={nodeRunOf({ id: "n", nodeId: "a", status: "running" })} />);
    expect(container.textContent).toBe("");
  });
});
