/** Condition-node helpers (§15.2) shared by the validator and the server's ConditionRunner. */

/** Error message of an invalid `new RegExp(pattern, flags)`, or null when it compiles. */
export function regexError(pattern: string, flags: string): string | null {
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
