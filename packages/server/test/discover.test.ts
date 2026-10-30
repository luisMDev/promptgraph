import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSlashCommands } from "../src/commands/discover.js";
import { AppSettingsStore } from "../src/config/app-settings.js";
import { tempDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("listSlashCommands", () => {
  it("finds project, user and plugin commands and skills; project shadows user", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const repo = path.join(dir, "repo");
    const user = path.join(dir, "claude");
    write(path.join(repo, ".claude/commands/ship.md"), '---\ndescription: "Ship it"\nargument-hint: [branch]\n---\nbody');
    write(path.join(repo, ".claude/commands/git/sync.md"), "# Sync with upstream\n\nmore");
    write(path.join(repo, ".claude/skills/lint/SKILL.md"), "---\nname: lint-fix\ndescription: Fix lint\n---\n");
    write(path.join(user, "commands/ship.md"), "---\ndescription: user ship\n---\n");
    write(path.join(user, "commands/mine.md"), "Mine");
    write(path.join(user, "skills/notes/SKILL.md"), "---\ndescription: Notes\n---\n");
    write(path.join(user, "skills/not-a-skill/README.md"), "x");
    const plugin = path.join(dir, "plugin");
    write(path.join(plugin, "commands/deploy.md"), "---\ndescription: Deploy\n---\n");
    write(path.join(plugin, "skills/audit/SKILL.md"), "---\ndescription: Audit\n---\n");
    write(
      path.join(user, "plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "ops@market": [{ installPath: plugin }] } }),
    );

    const commands = await listSlashCommands(repo, { CLAUDE_CONFIG_DIR: user });
    const byName = new Map(commands.map((c) => [c.name, c]));
    expect(byName.get("/ship")).toEqual({ name: "/ship", description: "Ship it", argumentHint: "[branch]", kind: "command", source: "project" });
    expect(byName.get("/git:sync")).toMatchObject({ description: "Sync with upstream", source: "project" });
    expect(byName.get("/lint-fix")).toMatchObject({ kind: "skill", description: "Fix lint" });
    expect(byName.get("/mine")).toMatchObject({ source: "user", description: "Mine" });
    expect(byName.get("/notes")).toMatchObject({ source: "user", kind: "skill" });
    expect(byName.get("/ops:deploy")).toMatchObject({ source: "plugin", kind: "command" });
    expect(byName.get("/ops:audit")).toMatchObject({ source: "plugin", kind: "skill" });
    expect(byName.get("/simplify")).toMatchObject({ source: "builtin" });
    expect(byName.has("/not-a-skill")).toBe(false);
    expect(commands.map((c) => c.name)).toEqual([...commands.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
  });

  it("returns only built-ins when nothing is configured", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const commands = await listSlashCommands(path.join(dir, "repo"), { CLAUDE_CONFIG_DIR: path.join(dir, "none") });
    expect(commands.every((c) => c.source === "builtin")).toBe(true);
  });
});

describe("AppSettingsStore", () => {
  it("defaults, persists and survives a corrupt file", () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const file = path.join(dir, "nested", "settings.json");
    const store = new AppSettingsStore(file);
    expect(store.get()).toEqual({ notifications: true });
    expect(store.update({ notifications: false })).toEqual({ notifications: false });
    expect(new AppSettingsStore(file).get()).toEqual({ notifications: false });
    expect(store.update({})).toEqual({ notifications: false });
    fs.writeFileSync(file, "{oops");
    expect(store.get()).toEqual({ notifications: true });
  });
});
