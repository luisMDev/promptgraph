/**
 * Whether the page runs in the promptgraph desktop window (DESIGN §20). The desktop bridge (CONTRACTS
 * §12.5) is not part of the web app yet, so the page always runs as a browser tab: the keymap uses the
 * browser bindings only.
 */
export function isDesktopWindow(): boolean {
  return false;
}
