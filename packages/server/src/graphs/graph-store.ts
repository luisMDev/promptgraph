import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { GRAPH_ID_PATTERN, GraphSchema, type Graph, type GraphListItem } from "@promptgraph/shared";
import { graphsDir } from "../config/paths.js";
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

/**
 * Called before every save/delete with the graph id; throws to refuse the write. The engine installs
 * one that rejects graphs with an active run (§5 "editable only when no run is active").
 */
export type GraphWriteGuard = (graphId: string) => void;

/** sha256 hex of a graph file's bytes. */
export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Pretty JSON (2 spaces, trailing newline) with stable key order, so files diff cleanly. Key order is
 * GraphSchema's declaration order (re-parsing normalises it and drops unknown keys).
 */
export function serializeGraph(graph: Graph): string {
  return `${JSON.stringify(GraphSchema.parse(graph), null, 2)}\n`;
}

const WATCH_DEBOUNCE_MS = 100;

/**
 * Graph files at `<repo>/.promptgraph/graphs/<id>.json` (§6, §11.1). Writes are atomic
 * (tmp + rename). Debouncing is client-side. Emits `graphs:changed` after save/delete and when
 * `watch()` sees an external change.
 */
export class GraphStore {
  private readonly dir: string;
  /** Hash of what this store last wrote per id (null = deleted), so watch() ignores its own writes. */
  private readonly ownWrites = new Map<string, string | null>();
  private writeGuard: GraphWriteGuard | null = null;

  constructor(
    readonly repoPath: string,
    private readonly bus: EventBus,
  ) {
    this.dir = graphsDir(repoPath);
  }

  /** Installs the save/delete guard (one at a time). */
  setWriteGuard(guard: GraphWriteGuard | null): void {
    this.writeGuard = guard;
  }

  /** Creates the graphs dir if missing (CLI step 3). */
  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Every *.json file, valid or not, sorted by name. */
  list(): GraphListItem[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((file): GraphListItem | null => {
        const id = file.slice(0, -".json".length);
        if (!GRAPH_ID_PATTERN.test(id)) {
          const content = fs.readFileSync(this.fileOf(id));
          const loadError = `Invalid file name "${file}": graph ids use lowercase letters, digits and dashes`;
          return { id, name: null, loadError, updatedAt: fs.statSync(this.fileOf(id)).mtimeMs, hash: hashContent(content) };
        }
        try {
          const loaded = this.get(id);
          return { id, name: loaded.graph.name, loadError: null, updatedAt: loaded.updatedAt, hash: loaded.hash };
        } catch (err) {
          if (err instanceof GraphLoadError) {
            const raw = this.readRaw(id);
            if (!raw) return null;
            return { id, name: null, loadError: err.message, updatedAt: raw.updatedAt, hash: hashContent(raw.content) };
          }
          if (err instanceof GraphNotFoundError) return null; // removed meanwhile
          throw err;
        }
      })
      .filter((g): g is GraphListItem => g !== null);
  }

  /** @throws GraphNotFoundError | GraphLoadError */
  get(id: string): LoadedGraph {
    const raw = this.readRaw(id);
    if (!raw) throw new GraphNotFoundError(id);
    let data: unknown;
    try {
      data = JSON.parse(raw.content.toString("utf8"));
    } catch (err) {
      throw new GraphLoadError(id, `Invalid JSON: ${(err as Error).message}`);
    }
    const parsed = GraphSchema.safeParse(data);
    if (!parsed.success) throw new GraphLoadError(id, z.prettifyError(parsed.error), parsed.error.issues);
    if (parsed.data.id !== id) {
      throw new GraphLoadError(id, `Graph id "${parsed.data.id}" does not match its file name "${id}.json"`);
    }
    return { graph: parsed.data, hash: hashContent(raw.content), updatedAt: raw.updatedAt };
  }

  /** Parses with GraphSchema (fills defaults), writes, returns the stored graph + new hash. */
  save(graph: Graph): LoadedGraph {
    const parsed = GraphSchema.parse(graph);
    this.writeGuard?.(parsed.id);
    this.ensureDir();
    const content = serializeGraph(parsed);
    const file = this.fileOf(parsed.id);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    const hash = hashContent(content);
    this.ownWrites.set(parsed.id, hash);
    this.bus.emit("graphs:changed", { graphId: parsed.id });
    return { graph: parsed, hash, updatedAt: fs.statSync(file).mtimeMs };
  }

  /** @throws GraphNotFoundError */
  delete(id: string): void {
    if (!this.readRaw(id)) throw new GraphNotFoundError(id);
    this.writeGuard?.(id);
    fs.rmSync(this.fileOf(id), { force: true });
    this.ownWrites.set(id, null);
    this.bus.emit("graphs:changed", { graphId: id });
  }

  /** fs.watch on the dir; emits graphs:changed for files changed outside the app. Returns a stop function. */
  watch(): () => void {
    this.ensureDir();
    const timers = new Map<string, NodeJS.Timeout>();
    const check = (id: string) => {
      timers.delete(id);
      const raw = this.readRaw(id);
      const hash = raw ? hashContent(raw.content) : null;
      if (this.ownWrites.has(id) && this.ownWrites.get(id) === hash) return;
      this.ownWrites.set(id, hash);
      this.bus.emit("graphs:changed", { graphId: id });
    };
    const watcher = fs.watch(this.dir, (_event, filename) => {
      const name = filename?.toString();
      if (!name?.endsWith(".json")) return;
      const id = name.slice(0, -".json".length);
      if (!GRAPH_ID_PATTERN.test(id)) return;
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => check(id), WATCH_DEBOUNCE_MS));
    });
    return () => {
      watcher.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** Raw bytes + mtime, or null when missing. Ids that are not valid graph ids never touch the fs. */
  private readRaw(id: string): { content: Buffer; updatedAt: number } | null {
    if (!GRAPH_ID_PATTERN.test(id)) return null;
    try {
      const file = this.fileOf(id);
      return { content: fs.readFileSync(file), updatedAt: fs.statSync(file).mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}
