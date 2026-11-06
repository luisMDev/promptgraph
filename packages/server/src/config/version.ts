/** Version of this package (kept in sync with packages/server/package.json). */
const PACKAGE_VERSION = "0.1.0";

/**
 * promptgraph version. `PG_VERSION_OVERRIDE` replaces it (tests only: a daemon of "another version" for
 * the version handshake, DESIGN §4.1 item 4); nothing else reads that variable.
 */
export const VERSION: string = process.env.PG_VERSION_OVERRIDE || PACKAGE_VERSION;

/**
 * Highest design phase the engine executes (ValidateOptions.phase): 2 since M5/M6 (edge conditions,
 * condition nodes, dead-path elimination, exclusive joins, loops).
 */
export const SUPPORTED_PHASE: 1 | 2 = 2;
