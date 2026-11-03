import manifest from "../public/recording/manifest.json";

/** Raw footage from scripts/record.mjs: screencast frames (seconds since the first frame) and story markers. */
export interface Recording {
  width: number;
  height: number;
  frames: { file: string; t: number }[];
  markers: Record<"editor" | "run" | "fanout" | "terminal" | "review-waiting" | "approval" | "pr" | "report" | "end", number>;
}

export const recording = manifest as Recording;

/** The screencast frame on screen at time `t` (the last one captured at or before it). */
export function frameAt(t: number): string {
  const { frames } = recording;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo]!.file;
}
