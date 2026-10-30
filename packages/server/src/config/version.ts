/** promptgraph version (kept in sync with packages/server/package.json). */
export const VERSION = "0.1.0";

/**
 * Highest design phase the engine executes (ValidateOptions.phase): 2 since M5/M6 (edge conditions,
 * condition nodes, dead-path elimination, exclusive joins, loops).
 */
export const SUPPORTED_PHASE: 1 | 2 = 2;
