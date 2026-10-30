/** promptgraph version (kept in sync with packages/server/package.json). */
export const VERSION = "0.1.0";

/**
 * Highest design phase the engine executes (ValidateOptions.phase). 1 until M5 ships edge conditions,
 * condition nodes and dead-path elimination; then 2.
 */
export const SUPPORTED_PHASE: 1 | 2 = 1;
