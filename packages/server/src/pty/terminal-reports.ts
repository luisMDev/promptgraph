/**
 * Sequences a terminal emulator (xterm.js) sends on its own rather than because the user typed:
 * replies to queries in the replayed or live output, focus reports (mode 1004) and mouse reports
 * (modes 1000–1006). They still go to the PTY, but must not count as user steering (§7.4), or merely
 * focusing or hovering a terminal would cancel auto completion.
 * Note: CPR (`CSI row;col R`) is indistinguishable from a modified F3 key; treating that key as a
 * report is harmless (it only fails to cancel the grace period).
 */
const TERMINAL_REPORTS: readonly RegExp[] = [
  /\x1b\[[IO]/g, // focus in / out
  /\x1b\[<\d+;\d+;\d+[Mm]/g, // SGR mouse
  /\x1b\[M[\s\S]{3}/g, // X10 / normal mouse
  /\x1b\[[?>][\d;]*c/g, // DA1 / DA2 replies
  /\x1b\[\??\d+;\d+R/g, // cursor position reports
  /\x1b\[\??[\d;]*\$y/g, // DECRPM (mode reports)
  /\x1b\[\?\d*u/g, // kitty keyboard flags reply
  /\x1b\[\d+;\d+;\d+t/g, // window size reports
  /\x1bP[\s\S]*?\x1b\\/g, // DCS replies (XTVERSION, DECRQSS, DA3)
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, // OSC replies (colour queries)
];

/** True when `data` contains anything besides terminal-generated reports. */
export function isUserTyping(data: string): boolean {
  let rest = data;
  for (const re of TERMINAL_REPORTS) rest = rest.replace(re, "");
  return rest.length > 0;
}
