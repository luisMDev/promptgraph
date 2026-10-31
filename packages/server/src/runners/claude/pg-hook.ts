import fs from "node:fs";
import path from "node:path";
import { PG_HOOK_SOURCE, type PgPaths } from "../../config/paths.js";

/** Copies assets/pg-hook to `<binDir>/pg-hook` (mode 0755) if missing or different; returns its absolute path. */
export function installPgHook(paths: PgPaths): string {
  const target = path.join(paths.binDir, "pg-hook");
  const source = fs.readFileSync(PG_HOOK_SOURCE);
  const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (!current || !current.equals(source)) {
    fs.mkdirSync(paths.binDir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, source, { mode: 0o755 });
    fs.renameSync(tmp, target);
  }
  fs.chmodSync(target, 0o755);
  return target;
}
