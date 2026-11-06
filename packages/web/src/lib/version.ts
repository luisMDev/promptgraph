declare const __PG_VERSION__: string | undefined;

/**
 * promptgraph version this web build belongs to (vite `define`, from packages/server/package.json), or
 * null outside a vite build (unit tests): the version check (DESIGN §13.5) is then off.
 */
export const BUILD_VERSION: string | null = typeof __PG_VERSION__ === "string" ? __PG_VERSION__ : null;
