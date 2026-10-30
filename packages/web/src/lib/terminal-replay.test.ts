import { describe, expect, it } from "vitest";
import { keepAlternateScreen } from "./terminal-replay";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("keepAlternateScreen", () => {
  it("drops alternate-screen exits and keeps everything else", () => {
    const log = "\x1b[?1049hPONG\x1b[?1049l\x1b[?47lResume this session";
    expect(dec(keepAlternateScreen(enc(log)))).toBe("\x1b[?1049hPONGResume this session");
  });

  it("returns the input unchanged when there is nothing to drop", () => {
    const bytes = enc("plain \x1b[2J output");
    expect(keepAlternateScreen(bytes)).toBe(bytes);
  });
});
