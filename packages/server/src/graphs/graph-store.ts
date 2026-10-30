import type { Graph, GraphListItem } from "@promptgraph/shared";
import type { EventBus } from "../events/bus.js";

export class GraphNotFoundError extends Error {
  constructor(readonly graphId: string) {
    super(`Graph "${graphId}" not found`);
  }
}

/** The file exists but is not valid JSON or fails GraphSchema; `message` is user-facing. */
export class GraphLoadError extends Error {
  constructor(
    readonly graphId: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface LoadedGraph {
  graph: Graph;
  /** sha256 hex of the raw file bytes. */
  hash: string;
  updatedAt: number;
}

/** sha256 hex of a graph file's bytes. */
export function hashContent(content: string | Buffer): string {
  throw new Error("not implemented");
}

/** Pretty JSON (2 spaces, trailing newline) with stable key order, so files diff cleanly. */
export function serializeGraph(graph: Graph): string {
  throw new Error("not implemented");
}

/**
 * Graph files at `<repo>/.promptgraph/graphs/<id>.json` (§6, §11.1). Writes are atomic
 * (tmp + rename). Debouncing is client-side. Emits `graphs:changed` after save/delete and when
 * `watch()` sees an external change.
 */
export class GraphStore {
  constructor(
    readonly repoPath: string,
    private readonly bus: EventBus,
  ) {}

  /** Creates the graphs dir if missing (CLI step 3). */
  ensureDir(): void {
    throw new Error("not implemented");
  }

  /** Every *.json file, valid or not, sorted by name. */
  list(): GraphListItem[] {
    throw new Error("not implemented");
  }

  /** @throws GraphNotFoundError | GraphLoadError */
  get(id: string): LoadedGraph {
    throw new Error("not implemented");
  }

  /** Parses with GraphSchema (fills defaults), writes, returns the stored graph + new hash. */
  save(graph: Graph): LoadedGraph {
    throw new Error("not implemented");
  }

  /** @throws GraphNotFoundError */
  delete(id: string): void {
    throw new Error("not implemented");
  }

  /** fs.watch on the dir; emits graphs:changed for files changed outside the app. Returns a stop function. */
  watch(): () => void {
    throw new Error("not implemented");
  }
}
