import { describe, expect, it } from "vitest";
import { FIT_MAX_ZOOM, FIT_MIN_ZOOM, readableViewport } from "./viewport";

describe("readableViewport", () => {
  const size = { width: 1000, height: 600 };

  it("centres a small graph without zooming in beyond 1", () => {
    const v = readableViewport({ x: 0, y: 0, width: 240, height: 80 }, size);
    expect(v.zoom).toBe(FIT_MAX_ZOOM);
    expect(v.x).toBe((1000 - 240) / 2);
    expect(v.y).toBe((600 - 80) / 2);
  });

  it("zooms out to fit a medium graph", () => {
    const v = readableViewport({ x: 100, y: 50, width: 1100, height: 300 }, size, 50);
    expect(v.zoom).toBeCloseTo(900 / 1100);
    expect(v.x + 100 * v.zoom).toBeCloseTo(50);
  });

  it("never goes below the readable minimum and aligns a wide graph to its left edge", () => {
    const v = readableViewport({ x: -200, y: 0, width: 5000, height: 200 }, size, 48);
    expect(v.zoom).toBe(FIT_MIN_ZOOM);
    // The leftmost node (the roots) starts at the padding.
    expect(v.x + -200 * v.zoom).toBeCloseTo(48);
    // Height still fits: vertically centred.
    expect(v.y).toBeCloseTo((600 - 200 * FIT_MIN_ZOOM) / 2);
  });

  it("aligns a tall graph to its top", () => {
    const v = readableViewport({ x: 0, y: 10, width: 300, height: 4000 }, size, 48);
    expect(v.zoom).toBe(FIT_MIN_ZOOM);
    expect(v.y + 10 * v.zoom).toBeCloseTo(48);
  });
});
