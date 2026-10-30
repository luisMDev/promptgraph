/** Viewport fitting for the canvas: readable zoom first, whole graph second. Pure. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Below this zoom node labels are no longer readable; fitting never zooms out further. */
export const FIT_MIN_ZOOM = 0.6;
export const FIT_MAX_ZOOM = 1;
/** Screen pixels kept free around the graph. */
export const FIT_PADDING_PX = 48;

/**
 * Viewport showing `bounds` (flow coordinates) in a `size` canvas at a zoom between FIT_MIN_ZOOM and
 * FIT_MAX_ZOOM. When the graph fits it is centred; when it does not fit at the minimum zoom, it is
 * aligned to its start (left / top, where the roots are) instead of being centred off-screen on both sides.
 */
export function readableViewport(bounds: Rect, size: { width: number; height: number }, padding = FIT_PADDING_PX): Viewport {
  const availW = Math.max(1, size.width - 2 * padding);
  const availH = Math.max(1, size.height - 2 * padding);
  const fit = Math.min(availW / Math.max(1, bounds.width), availH / Math.max(1, bounds.height));
  const zoom = Math.min(FIT_MAX_ZOOM, Math.max(FIT_MIN_ZOOM, fit));
  const w = bounds.width * zoom;
  const h = bounds.height * zoom;
  const x = w <= availW ? (size.width - w) / 2 - bounds.x * zoom : padding - bounds.x * zoom;
  const y = h <= availH ? (size.height - h) / 2 - bounds.y * zoom : padding - bounds.y * zoom;
  return { x, y, zoom };
}
