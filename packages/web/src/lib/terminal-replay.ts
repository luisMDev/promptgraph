/** "Leave alternate screen" sequences: ESC [ ? 1049 l, ESC [ ? 1047 l, ESC [ ? 47 l. */
const ALT_SCREEN_EXITS = ["\x1b[?1049l", "\x1b[?1047l", "\x1b[?47l"].map((s) => new TextEncoder().encode(s));

/**
 * Full-screen TUIs (Claude Code) draw in the alternate screen and leave it on exit, so a replayed log
 * would end on the nearly empty main screen. Dropping the exit sequences keeps the last screen visible.
 */
export function keepAlternateScreen(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  outer: for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x1b) {
      for (const seq of ALT_SCREEN_EXITS) {
        if (matchesAt(bytes, i, seq)) {
          i += seq.length - 1;
          continue outer;
        }
      }
    }
    out.push(bytes[i]!);
  }
  return out.length === bytes.length ? bytes : Uint8Array.from(out);
}

function matchesAt(bytes: Uint8Array, at: number, seq: Uint8Array): boolean {
  if (at + seq.length > bytes.length) return false;
  for (let j = 0; j < seq.length; j++) if (bytes[at + j] !== seq[j]) return false;
  return true;
}
