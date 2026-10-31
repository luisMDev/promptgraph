import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SlashCommand } from "@promptgraph/shared";

type Source = SlashCommand["source"];

/** Built-in commands/skills worth offering in a pipeline (§6.1 examples). */
const BUILTINS: readonly SlashCommand[] = [
  { name: "/init", description: "Initialize a CLAUDE.md file with codebase documentation", argumentHint: null, kind: "command", source: "builtin" },
  { name: "/review", description: "Review a pull request", argumentHint: null, kind: "command", source: "builtin" },
  { name: "/security-review", description: "Security review of the pending changes on the current branch", argumentHint: null, kind: "command", source: "builtin" },
  { name: "/code-review", description: "Review the current diff for correctness bugs", argumentHint: "[low|medium|high]", kind: "skill", source: "builtin" },
  { name: "/simplify", description: "Review the changed code for reuse and simplification, then apply the fixes", argumentHint: null, kind: "skill", source: "builtin" },
];

const SOURCE_PRIORITY: Record<Source, number> = { project: 0, user: 1, plugin: 2, builtin: 3 };
const MAX_DEPTH = 6;
const DESCRIPTION_MAX = 200;

/**
 * Slash commands and skills for the `command` picker (GET /api/commands): project `.claude/commands/**.md`
 * and `.claude/skills/<name>/SKILL.md`, user `$CLAUDE_CONFIG_DIR|~/.claude` equivalents, installed plugin
 * commands, plus a fixed list of useful built-ins. Frontmatter `description` / `argument-hint` are read.
 * Nested command dirs map to `/dir:name`. Sorted by name, project shadows user.
 */
export async function listSlashCommands(repoPath: string, env: NodeJS.ProcessEnv = process.env): Promise<SlashCommand[]> {
  const userDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude");
  const projectDir = path.join(repoPath, ".claude");
  const found = (
    await Promise.all([
      scanCommands(path.join(projectDir, "commands"), "project", ""),
      scanSkills(path.join(projectDir, "skills"), "project", ""),
      scanCommands(path.join(userDir, "commands"), "user", ""),
      scanSkills(path.join(userDir, "skills"), "user", ""),
      scanPlugins(userDir),
    ])
  ).flat();

  const byName = new Map<string, SlashCommand>();
  for (const cmd of [...found, ...BUILTINS]) {
    const existing = byName.get(cmd.name);
    if (!existing || SOURCE_PRIORITY[cmd.source] < SOURCE_PRIORITY[existing.source]) byName.set(cmd.name, cmd);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `<dir>/**.md` → `/<prefix><a:b:name>`. */
async function scanCommands(dir: string, source: Source, prefix: string): Promise<SlashCommand[]> {
  const files = await listMarkdown(dir, 0);
  return Promise.all(
    files.map(async (file) => {
      const rel = path.relative(dir, file).slice(0, -".md".length);
      const meta = await readMeta(file);
      return {
        name: `/${prefix}${rel.split(path.sep).join(":")}`,
        description: meta.description,
        argumentHint: meta.argumentHint,
        kind: "command" as const,
        source,
      };
    }),
  );
}

/** `<dir>/<name>/SKILL.md` → `/<prefix><frontmatter name ?? dir name>`. */
async function scanSkills(dir: string, source: Source, prefix: string): Promise<SlashCommand[]> {
  const entries = await readDir(dir);
  const skills = await Promise.all(
    entries.map(async (entry): Promise<SlashCommand | null> => {
      const file = path.join(dir, entry.name, "SKILL.md");
      if (!(await isFile(file))) return null;
      const meta = await readMeta(file);
      return {
        name: `/${prefix}${meta.name ?? entry.name}`,
        description: meta.description,
        argumentHint: meta.argumentHint,
        kind: "skill",
        source,
      };
    }),
  );
  return skills.filter((s): s is SlashCommand => s !== null);
}

/** Installed plugins (`plugins/installed_plugins.json`, v1 or v2 format): `/<plugin>:<command|skill>`. */
async function scanPlugins(userDir: string): Promise<SlashCommand[]> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.promises.readFile(path.join(userDir, "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return [];
  }
  const plugins = (manifest as { plugins?: unknown })?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const results = await Promise.all(
    Object.entries(plugins as Record<string, unknown>).map(async ([key, value]) => {
      const install = (Array.isArray(value) ? value[0] : value) as { installPath?: unknown } | undefined;
      if (typeof install?.installPath !== "string") return [];
      const prefix = `${key.split("@")[0]}:`;
      const [commands, skills] = await Promise.all([
        scanCommands(path.join(install.installPath, "commands"), "plugin", prefix),
        scanSkills(path.join(install.installPath, "skills"), "plugin", prefix),
      ]);
      return [...commands, ...skills];
    }),
  );
  return results.flat();
}

async function listMarkdown(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const out: string[] = [];
  for (const entry of await readDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdown(full, depth + 1)));
    else if (entry.name.endsWith(".md") && (await isFile(full))) out.push(full);
  }
  return out;
}

async function readDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

interface Meta {
  name: string | null;
  description: string | null;
  argumentHint: string | null;
}

/** Simple `key: value` frontmatter; without a description, the first body line is used (like Claude Code). */
async function readMeta(file: string): Promise<Meta> {
  let content: string;
  try {
    content = await fs.promises.readFile(file, "utf8");
  } catch {
    return { name: null, description: null, argumentHint: null };
  }
  const fields = new Map<string, string>();
  let body = content;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (fm) {
    body = content.slice(fm[0].length);
    for (const line of (fm[1] ?? "").split(/\r?\n/)) {
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (m?.[1] && m[2] !== undefined) fields.set(m[1], unquote(m[2].trim()));
    }
  }
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  const description = fields.get("description") || firstLine || null;
  return {
    name: fields.get("name") || null,
    description: description ? description.slice(0, DESCRIPTION_MAX) : null,
    argumentHint: fields.get("argument-hint") || null,
  };
}

function unquote(value: string): string {
  const m = /^(["'])(.*)\1$/.exec(value);
  return m?.[2] ?? value;
}
