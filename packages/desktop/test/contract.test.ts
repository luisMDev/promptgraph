import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAEMON_RESTART_PROGRESS_PREFIX,
  DESKTOP_COMMANDS,
  DESKTOP_DIALOGS,
  DESKTOP_INSTALL_ARGS,
  DESKTOP_MOUNT_PATH_LISTS,
  DESKTOP_OPEN_ARGS,
  DESKTOP_PERMISSIONS,
  DESKTOP_STRIPPED_ENV,
  DESKTOP_STRIPPED_ENV_PREFIXES,
  EXIT_VERSION_MISMATCH,
  VERSION_MISMATCH_POLICIES,
} from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { NODE_VERSION as NODE_VERSION_PINNED } from "../scripts/prepare-runtime.mjs";

/**
 * The desktop shell cannot be compiled where the suite runs (no Rust, no WebKitGTK), so its invariants
 * (DESIGN §20.5) are checked on the files as text, against the constants of packages/shared/src/desktop.ts.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = path.join(root, "src-tauri");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "target" || e.name === "gen" || e.name === "node_modules" ? [] : listFiles(p);
    return [p];
  });
}

interface RustSource {
  /** Comments removed, string literals kept. */
  code: string;
  /** Same offsets as `code`, string and char literal contents blanked (for brace matching). */
  skeleton: string;
  /** Every string literal's value (escapes left as written). */
  strings: string[];
}

/** A small Rust lexer: enough to strip comments and find string literals in src/*.rs and build.rs. */
function lexRust(src: string): RustSource {
  let code = "";
  let skeleton = "";
  const strings: string[] = [];
  let i = 0;
  const emit = (text: string, blank: boolean) => {
    code += text;
    skeleton += blank ? text.replace(/[^\n]/g, " ") : text;
  };
  while (i < src.length) {
    const rest = src.slice(i);
    if (rest.startsWith("//")) {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const raw = /^r(#*)"/.exec(rest);
    if (raw) {
      const close = `"${raw[1]}`;
      const end = src.indexOf(close, i + raw[0].length);
      const value = src.slice(i + raw[0].length, end);
      strings.push(value);
      emit(raw[0], false);
      emit(value, true);
      emit(close, false);
      i = end + close.length;
      continue;
    }
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      const value = src.slice(i + 1, j);
      strings.push(value);
      emit('"', false);
      emit(value, true);
      emit('"', false);
      i = j + 1;
      continue;
    }
    if (src[i] === "'") {
      // A char literal ('x', '\\', '\n'); a lifetime ('a) is left as code.
      const len = src[i + 1] === "\\" ? src.indexOf("'", i + 3) - i + 1 : src[i + 2] === "'" ? 3 : 0;
      if (len > 0) {
        emit("'", false);
        emit(src.slice(i + 1, i + len - 1), true);
        emit("'", false);
        i += len;
        continue;
      }
    }
    emit(src[i]!, false);
    i += 1;
  }
  return { code, skeleton, strings };
}

/** The body (between the braces) of `fn <name>` in a lexed source. */
function fnBody(src: RustSource, name: string): string {
  const at = new RegExp(`\\bfn ${name}\\b`).exec(src.skeleton);
  if (!at) throw new Error(`fn ${name} not found`);
  const open = src.skeleton.indexOf("{", at.index);
  let depth = 0;
  for (let i = open; i < src.skeleton.length; i++) {
    if (src.skeleton[i] === "{") depth++;
    else if (src.skeleton[i] === "}" && --depth === 0) return src.code.slice(open + 1, i);
  }
  throw new Error(`fn ${name} is not closed`);
}

/** Top-level items (with their attributes) as [start, end) ranges of the lexed source. */
function topLevelItems(src: RustSource): Array<{ start: number; end: number; text: string }> {
  const items: Array<{ start: number; end: number; text: string }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.skeleton.length; i++) {
    const c = src.skeleton[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0 && c === "}") {
        items.push({ start, end: i + 1, text: src.code.slice(start, i + 1) });
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      items.push({ start, end: i + 1, text: src.code.slice(start, i + 1) });
      start = i + 1;
    }
  }
  return items;
}

const rustFiles = fs.readdirSync(path.join(tauriDir, "src")).filter((f) => f.endsWith(".rs")).sort();
const rust = Object.fromEntries(rustFiles.map((f) => [f, lexRust(read(`src-tauri/src/${f}`))])) as Record<string, RustSource>;
const mainRs = rust["main.rs"]!;
const dialogRs = rust["dialog.rs"]!;
const updateRs = rust["update.rs"]!;
const buildRs = lexRust(read("src-tauri/build.rs"));
/** Every string literal of every Rust file. */
const rustStrings = [...Object.values(rust), buildRs].flatMap((src) => src.strings);

/** The quoted items of `const <name>: [&str; N] = [ … ];` in a lexed source. */
function constArray(src: RustSource, name: string): string[] {
  const at = new RegExp(`const ${name}: \\[&str; (\\d+)\\] = \\[([^\\]]*)\\];`).exec(src.code);
  if (!at) throw new Error(`const ${name} not found`);
  const items = [...at[2]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  expect(items.length, name).toBe(Number(at[1]));
  return items;
}

/** The value of `const <name>: &str = "…";`. */
function constStr(src: RustSource, name: string): string {
  const at = new RegExp(`const ${name}: &str = "([^"]*)";`).exec(src.code);
  if (!at) throw new Error(`const ${name} not found`);
  return at[1]!;
}

/** Every string value (and key) of a parsed JSON document. */
function jsonStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, ...jsonStrings(v)]);
  return [];
}

/**
 * Updater private-key material (DESIGN §20.11): the minisign/rsign header in plain text, and the base64 of
 * its whole 3-byte groups (a Tauri key file is the base64 of the whole minisign file, so the plain header
 * never appears in it). Assembled at run time so this file never matches itself.
 */
const KEY_NEEDLES = ["rsign", "minisign"].flatMap((kind) => {
  const header = "untrusted comment: " + kind + " encrypted secret key";
  const aligned = header.slice(0, header.length - (header.length % 3));
  return [header, Buffer.from(aligned).toString("base64")];
});

function filesWithKeyMaterial(files: string[]): string[] {
  return files.filter((file) => {
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch {
      return false; // deleted in the working tree
    }
    return KEY_NEEDLES.some((needle) => data.includes(needle));
  });
}
const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
  identifier: string;
  productName: string;
  build: { frontendDist: string; devUrl?: string; beforeBuildCommand?: string };
  app: { withGlobalTauri: boolean; windows: unknown[]; security: { csp: string } };
  bundle: { targets: string[] };
};

describe("tauri.conf.json", () => {
  it("serves the bundled splash, builds windows in code and exposes the global API", () => {
    expect(conf.identifier).toBe("dev.promptgraph.desktop");
    expect(conf.productName).toBe("promptgraph");
    expect(conf.build.frontendDist).toBe("../splash");
    expect(conf.build.devUrl).toBeUndefined();
    expect(conf.build.beforeBuildCommand).toBeUndefined();
    expect(conf.app.withGlobalTauri).toBe(true);
    expect(conf.app.windows).toEqual([]);
    expect(conf.bundle.targets).toEqual(["deb", "appimage"]);
  });

  it("gives the splash a CSP with no network access", () => {
    const csp = conf.app.security.csp;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/https?:|\*/);
  });
});

describe("capabilities", () => {
  it("has no static capability with a remote URL", () => {
    for (const file of listFiles(path.join(tauriDir, "capabilities"))) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/remote|https?:\/\//);
    }
  });

  it("never grants a wildcard loopback port anywhere", () => {
    const files = [...listFiles(tauriDir), ...listFiles(path.join(root, "splash"))];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files.filter((f) => /\.(rs|json|toml|html|js)$/.test(f))) {
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/127\.0\.0\.1:\*|localhost:\*/);
    }
  });

  it("main.rs grants exactly DESKTOP_PERMISSIONS, the opener one scoped to https", () => {
    const listed = rustStrings.filter((s) => /^(core:|opener:|allow-)/.test(s));
    expect([...listed].sort()).toEqual([...DESKTOP_PERMISSIONS].sort());
    const opener = "opener:allow-open-url";
    expect([...constArray(mainRs, "PERMISSIONS"), opener].sort()).toEqual([...DESKTOP_PERMISSIONS].sort());
    expect(constStr(mainRs, "OPENER_PERMISSION")).toBe(opener);
    expect(mainRs.code).toMatch(/permission_scoped\(\s*OPENER_PERMISSION/);
    expect(mainRs.strings).toContain("https://*");
    // The capability is built from these constants only.
    const capability = fnBody(mainRs, "capability");
    expect(capability).toContain("PERMISSIONS.iter().fold(cap, |cap, permission| cap.permission(*permission))");
    expect(capability.match(/\.permission(_scoped)?\(/g)).toHaveLength(2);
  });

  it("no updater, dialog or process permission appears in any Rust string or JSON file (DESIGN §20.10)", () => {
    const forbidden = /^(updater|dialog|process):[a-z-]+$/;
    expect(forbidden.test("updater:default")).toBe(true);
    expect(forbidden.test("tauri_plugin_updater::Builder")).toBe(false);
    expect(rustStrings.filter((s) => forbidden.test(s))).toEqual([]);
    const jsonFiles = listFiles(tauriDir).filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBeGreaterThanOrEqual(3);
    for (const file of jsonFiles) {
      const values = jsonStrings(JSON.parse(fs.readFileSync(file, "utf8")));
      expect(values.filter((s) => forbidden.test(s)), file).toEqual([]);
    }
  });

  it("adds the capability at run time for the main window and exactly the daemon origin and its paths", () => {
    const body = fnBody(mainRs, "capability");
    expect(body).toContain("CapabilityBuilder::new(");
    expect(body).toContain('.window("main")');
    expect(body).toContain(".local(false)");
    expect(body).toContain(".remote(origin.to_string())");
    expect(body).toContain('.remote(format!("{origin}/*"))');
    expect(fnBody(mainRs, "go")).toMatch(/\.add_capability\(capability\(/);
    expect(fnBody(mainRs, "target")).toContain('format!("http://127.0.0.1:{}", opened.port)');
  });
});

describe("commands", () => {
  const commands = Object.values(DESKTOP_COMMANDS);

  it("build.rs declares exactly DESKTOP_COMMANDS in the app manifest", () => {
    expect(buildRs.code).toMatch(/tauri_build::try_build\(/);
    const manifest = /AppManifest::new\(\)\s*\.commands\(&\[([^\]]*)\]\)/.exec(buildRs.code);
    expect(manifest).not.toBeNull();
    const declared = [...manifest![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...commands].sort());
  });

  it("main registers only the opener and updater plugins", () => {
    const plugins = [...fnBody(mainRs, "main").matchAll(/\.plugin\(([^\n]*)\)\n/g)].map((m) => m[1]);
    expect(plugins).toEqual(["tauri_plugin_opener::init()", "tauri_plugin_updater::Builder::new().build()"]);
    for (const src of Object.values(rust)) expect(src.code).not.toMatch(/tauri_plugin_(dialog|process)/);
  });

  it("main.rs registers exactly those commands", () => {
    const handler = /generate_handler!\[([^\]]*)\]/.exec(mainRs.code);
    expect(handler).not.toBeNull();
    const registered = handler![1]!.split(",").map((s) => s.trim()).filter(Boolean);
    expect(registered.sort()).toEqual([...commands].sort());
    for (const name of commands) expect(mainRs.code).toMatch(new RegExp(`#\\[tauri::command\\]\\s*async fn ${name}\\(`));
  });

  it("relogin validates next, never returns a URL and writes the allowed-origin Mutex", () => {
    const relogin = fnBody(mainRs, "relogin");
    expect(relogin).toMatch(/if !safe_next\(&next\)/);
    expect(relogin).toMatch(/run_cli\([^)]*Some\(&next\)\)/);
    expect(relogin).toContain("go(&app, &shared, opened)");
    expect(mainRs.code).toMatch(/async fn relogin\(app: AppHandle, next: String\) -> Result<\(\), String>/);
    expect(mainRs.code).toMatch(/origin: Mutex<Option<String>>/);
    const go = fnBody(mainRs, "go");
    // Granted first, then allowed, then navigated; a failed navigation restores the previous origin, so a
    // failing relogin never leaves the window on a page its guard refuses.
    expect(go).toMatch(/\.add_capability\([\s\S]*let previous = shared\.origin\.lock\(\)\.unwrap\(\)\.replace\(origin\);[\s\S]*window\.navigate\(url\)/);
    expect(go).toMatch(/navigate\(url\)\.map_err\(\|_\| \{\s*\*shared\.origin\.lock\(\)\.unwrap\(\) = previous;\s*shared\.showing_splash\.store\(was_splash/);
    // The navigation error is replaced: it could quote the login URL.
    expect(go).toMatch(/navigate\(url\)\.map_err\(\|_\|/);
    const safeNext = fnBody(mainRs, "safe_next");
    expect(safeNext).toContain("starts_with('/')");
    expect(safeNext).toContain('!next.contains("//")');
    expect(safeNext).toContain("!next.contains('\\\\')");
  });
});

describe("CLI invocation", () => {
  it("runs `open --print-url --json [--next] [repo]` through the login shell", () => {
    for (const arg of [...DESKTOP_OPEN_ARGS, "--next", "-ilc", 'exec "$0" "$@"', "PROMPTGRAPH_BIN", "SHELL"]) {
      expect(mainRs.strings, arg).toContain(arg);
    }
    expect(mainRs.code).toContain('const POSIX_EXEC: &str = r#"exec "$0" "$@""#;');
    expect(constArray(mainRs, "OPEN_ARGS")).toEqual([...DESKTOP_OPEN_ARGS]);
    const run = fnBody(mainRs, "run_cli");
    expect(run).toContain("let (shell, flags, script) = login_shell();");
    expect(run).toMatch(/\.arg\(flags\)\.arg\(script\)\.arg\(&cli\.path\)\.args\(OPEN_ARGS\)\.args\(\["--on-version-mismatch", policy\]\)/);
    expect(run).toContain("run_captured(cmd, timeout, &progress)");
    expect(fnBody(mainRs, "run_captured")).toContain("stdin(Stdio::null())");
  });

  it("uses the POSIX form for POSIX shells, $argv for fish and /bin/sh -l for any other shell", () => {
    const shell = fnBody(mainRs, "login_shell");
    expect(shell).toContain('"sh" | "bash" | "zsh" | "dash" | "ash" | "ksh" | "mksh" => (shell, "-ilc", POSIX_EXEC)');
    expect(shell).toContain('"fish" => (shell, "-ilc", "exec $argv")');
    expect(shell).toContain('_ => ("/bin/sh".into(), "-lc", POSIX_EXEC)');
  });

  it("runs the shell in its own session, kills the whole session on timeout and reads output without waiting for EOF", () => {
    const run = fnBody(mainRs, "run_captured");
    expect(run).toMatch(/pre_exec\(\|\| if libc::setsid\(\) == -1/);
    expect(run).toContain("libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL)");
    expect(run).not.toContain("child.kill()");
    // The session is killed after the grace period on every path, not only on timeout: a job a start-up
    // file left running would otherwise keep the pipes, and the reader threads, alive.
    expect(run.split("libc::SIGKILL").length - 1).toBe(1);
    expect(run).toMatch(/is_finished\(\)\) && Instant::now\(\) < grace[\s\S]*libc::kill\([\s\S]*let Some\(status\) = status else/);
    // A background job of a start-up file may hold the pipes open: the readers append as they read and
    // run_cli uses what was read after a short grace period, not only at EOF.
    expect(mainRs.code).not.toContain("read_to_end");
    expect(fnBody(mainRs, "drain")).toContain("extend_from_slice(&chunk[..n])");
    expect(run).toMatch(/out_reader\.is_finished\(\) && err_reader\.is_finished\(\)/);
    expect(run).not.toContain("recv_timeout");
    // Every child goes through run_captured: the login shell, the installer and the shim commands. The one
    // other spawn is the app's own relaunch after an update (update.rs), which nothing waits for.
    const spawns = (src: RustSource) => src.code.match(/\.spawn\(\)/g)?.length ?? 0;
    for (const src of Object.values(rust)) expect(spawns(src)).toBeLessThanOrEqual(src === mainRs || src === updateRs ? 1 : 0);
    expect(fnBody(updateRs, "relaunch")).toContain("cmd.spawn()");
    expect(fnBody(mainRs, "run_json")).toContain("run_captured(cmd, timeout, &|_| {})");
    // The runtime is the app's own version: a missing line is reported as such, never as "≥ version required".
    expect(fnBody(mainRs, "run_json")).toContain("returned no result");
    expect(fnBody(mainRs, "run_json")).not.toContain("version_required");
  });

  it("uses the budgets of DESIGN §20.1 item 4", () => {
    expect(mainRs.code).toContain("const CLI_TIMEOUT: Duration = Duration::from_secs(30);");
    expect(mainRs.code).toContain("const HANDOVER_TIMEOUT: Duration = Duration::from_secs(90);");
    expect(mainRs.code).toContain("const INSTALL_TIMEOUT: Duration = Duration::from_secs(120);");
    expect(fnBody(mainRs, "run_cli")).toContain('let timeout = if cli.bundled && policy != "attach" { HANDOVER_TIMEOUT } else { CLI_TIMEOUT };');
    expect(fnBody(mainRs, "install_runtime")).toContain("run_json(&launcher, &INSTALL_ARGS, INSTALL_TIMEOUT)");
    expect(fnBody(mainRs, "install_runtime")).toMatch(/run_json::<ShimResult>\(&installed\.cli_path, &args, CLI_TIMEOUT\)/);
  });

  it("removes exactly the DESKTOP_STRIPPED_ENV names and prefixes, and the DESKTOP_MOUNT_PATH_LISTS entries under $APPDIR or any AppImage mount", () => {
    expect([...constArray(mainRs, "STRIPPED_ENV")].sort()).toEqual([...DESKTOP_STRIPPED_ENV].sort());
    expect([...constArray(mainRs, "STRIPPED_ENV_PREFIXES")].sort()).toEqual([...DESKTOP_STRIPPED_ENV_PREFIXES].sort());
    expect(fnBody(mainRs, "run_captured").trimStart().startsWith("strip_env(&mut cmd, true);")).toBe(true);
    const strip = fnBody(mainRs, "strip_env");
    // Every name for the CLI. The app's own relaunch (cli = false) keeps the PG_DESKTOP_* settings, and the
    // prefixed variables and RELAUNCH_FILTERED unless they point into a mount (WEBKIT_DISABLE_DMABUF_RENDERER=1).
    expect(strip).toMatch(/for name in STRIPPED_ENV \{ if cli \|\| !\(name\.starts_with\("PG_DESKTOP_"\) \|\| RELAUNCH_FILTERED\.contains\(&name\)\) \{ cmd\.env_remove\(name\); \} \}/);
    expect(DESKTOP_STRIPPED_ENV.filter((n) => n.startsWith("PG_DESKTOP_")).sort()).toEqual(["PG_DESKTOP_AUTO_ANSWER", "PG_DESKTOP_UPDATES"]);
    expect(constArray(mainRs, "RELAUNCH_FILTERED")).toEqual(["LD_LIBRARY_PATH", "LD_PRELOAD"]);
    for (const name of constArray(mainRs, "RELAUNCH_FILTERED")) expect(DESKTOP_STRIPPED_ENV, name).toContain(name);
    expect(strip).toMatch(/STRIPPED_ENV_PREFIXES\.iter\(\)\.any\(\|p\| k\.starts_with\(p\)\)/);
    expect(strip).toMatch(/if cli && prefixed \{\s*cmd\.env_remove\(&key\);\s*\} else if !cli && \(prefixed \|\| RELAUNCH_FILTERED\.contains\(&k\)\) \{/);
    expect(strip).toMatch(/match relaunch_value\(v, &appdir\) \{[\s\S]*None => \{ cmd\.env_remove\(&key\); \}/);
    expect(fnBody(mainRs, "relaunch_value")).toMatch(/if !entries\(\)\.any\(\|e\| in_mount\(e, appdir\)\) \{ return Some\(value\.to_string\(\)\); \}/);
    expect(constArray(mainRs, "MOUNT_PATH_LISTS")).toEqual([...DESKTOP_MOUNT_PATH_LISTS]);
    expect(strip).toContain("for name in MOUNT_PATH_LISTS {");
    // OWD only from the AppImage it belongs to: it is inherited by anything started from that AppImage's terminal.
    expect(strip).toContain("if let Some(dir) = owd() { cmd.current_dir(dir); }");
    expect(fnBody(mainRs, "caller_dir")).toMatch(/^\s*appdir_of\(env, exe\?\)\.ok\(\)\?;\s*env\("OWD"\)/);
    expect(mainRs.code.split("#[cfg(test)]")[0]!.match(/"OWD"/g)?.length).toBe(2); // STRIPPED_ENV and caller_dir
    const appdirOf = fnBody(mainRs, "appdir_of");
    for (const needle of ['env("APPDIR")', "std::fs::canonicalize(exe)", "exe.starts_with(&appdir)"]) expect(appdirOf, needle).toContain(needle);
    expect(strip).toContain('std::env::var("APPDIR")');
    expect(strip).toMatch(/without_dirs_under\(&value, &appdir\)[\s\S]*Ok\(None\) => \{ cmd\.env_remove\(name\); \}/);
    expect(fnBody(mainRs, "without_dirs_under")).toContain("!in_mount(dir, appdir)");
    expect(fnBody(mainRs, "in_mount")).toMatch(/s\.starts_with\("\.mount_"\) \|\| s\.starts_with\("appimage_extracted_"\)/);
    // Read from this process before anything else: the variable never reaches a child.
    expect(fnBody(mainRs, "main").trimStart().startsWith("dialog::init();")).toBe(true);
  });

  it("takes the last JSON object, checks v == 1 and maps the splash errors (DESIGN §20.1 item 4)", () => {
    const run = fnBody(mainRs, "run_cli");
    expect(run).toContain("last_json_object(&out.stdout)");
    // Start-up files may print on the CLI's own line (Warp's escape sequences): search for `{"v":` first.
    const parse = fnBody(mainRs, "last_json_object");
    expect(parse).toContain('rmatch_indices("{\\"v\\":")');
    expect(parse).toMatch(/\.lines\(\)\.rev\(\)/);
    expect(run).toContain('last.get("v") != Some(&serde_json::json!(1))');
    expect(run).toContain("Some(127) => return Err(NOT_FOUND.into())");
    // stderr also carries the login shell's start-up messages: never guess "not found" from its text.
    expect(run).not.toMatch(/stderr\.contains\(/);
    expect(run).toContain("Some(2) => return Err(version_required())");
    expect(run).toContain("CLI_TIMEOUT");
    expect(mainRs.strings).toContain("promptgraph CLI not found: install it with `npm i -g promptgraph` or set `PROMPTGRAPH_BIN`");
    expect(mainRs.strings.some((s) => s.startsWith("promptgraph ≥ {} is required"))).toBe(true);
    expect(fnBody(mainRs, "start_from_splash")).toContain('splash(&app, "__pgSplashError", &message)');
    const splash = fnBody(mainRs, "splash");
    expect(splash).toContain('window.eval(format!("window.{function}({arg})"))');
    // Only into the splash itself, never into the daemon's page.
    expect(splash).toMatch(/if !window\.url\(\)\.is_ok_and\(\|url\| is_splash\(&url, dev_origin\)\) \{ return; \}[\s\S]*window\.eval/);
    expect(splash).toContain("serde_json::to_string(text)");
  });

  it("asks before taking over a daemon of another version and retries once (DESIGN §20.9)", () => {
    expect(mainRs.code).toContain(`const EXIT_VERSION_MISMATCH: i32 = ${EXIT_VERSION_MISMATCH};`);
    for (const policy of VERSION_MISMATCH_POLICIES) expect(mainRs.strings, policy).toContain(policy);
    expect(mainRs.strings).toContain("--on-version-mismatch");
    expect(mainRs.code).toMatch(/mismatch_policy: Mutex::new\("auto"\)/);
    const run = fnBody(mainRs, "run_cli");
    expect(run).toContain("for attempt in 0..2 {");
    expect(run).toContain("Some(EXIT_VERSION_MISMATCH) if attempt == 0 => { policy = handover(app, shared, &out.stdout)?; continue; }");
    expect(run).toContain("Some(EXIT_VERSION_MISMATCH) => return Err(version_required())");
    const handover = fnBody(mainRs, "handover");
    expect(handover).toContain('ask(app, "version-mismatch"');
    expect(handover).toContain('*shared.mismatch_policy.lock().unwrap() = "attach";');
    expect(handover).toMatch(/else \{ return Err\(version_required\(\)\) \}/);
    expect(handover).toContain("Restarting promptgraph {new}…");
    expect(constStr(mainRs, "RESTART_PROGRESS")).toBe(DAEMON_RESTART_PROGRESS_PREFIX);
    expect(run).toMatch(/line\.starts_with\(RESTART_PROGRESS\)[^\n]*"__pgSplashStatus"/);
  });

  it("installs the bundled runtime and runs its versioned launcher, after PROMPTGRAPH_BIN (DESIGN §20.7)", () => {
    expect(constArray(mainRs, "INSTALL_ARGS")).toEqual([...DESKTOP_INSTALL_ARGS]);
    const bin = fnBody(mainRs, "cli_bin");
    expect(bin).toMatch(/if let Some\(cli\) = shared\.bin\.get\(\) \{ return Ok\(cli\); \}/);
    expect(bin).toMatch(/"PROMPTGRAPH_BIN"[\s\S]*dir\.join\("manifest\.json"\)\.is_file\(\)[\s\S]*install_runtime\(app, &runtime\)\?[\s\S]*"promptgraph"\.into\(\)/);
    expect(mainRs.code).toContain('app.path().resource_dir().map(|dir| dir.join("runtime"))');
    expect(mainRs.code).toContain("bin: OnceLock<Cli>");
    const install = fnBody(mainRs, "install_runtime");
    expect(install).toContain("Ok(installed.cli_path)");
    expect(install).not.toContain("current");
    expect(install).toContain('(shim.decision.is_none() && shim.state != "ours").then(|| shim_question(app, &shim)).flatten()');
    expect(install).toMatch(/if args\.contains\(&"install"\) \{ shim_failed\(app, &shim\.path, &e\); \}/);
    expect(install).toContain("if shim.warn { path_warning(app, &shim); }");
    expect(install).toMatch(/"__pgSplashStatus", &format!\("Installing promptgraph/);
  });

  it("uses exactly the questions and button keys of DESKTOP_DIALOGS", () => {
    const asked = [...Object.values(rust).map((src) => src.code).join("\n").matchAll(/\bask\(app, "([a-z-]+)"/g)].map((m) => m[1]);
    expect([...new Set(asked)].sort()).toEqual(Object.keys(DESKTOP_DIALOGS).sort());
    for (const [id, keys] of Object.entries(DESKTOP_DIALOGS)) {
      expect(rustStrings, id).toContain(id);
      for (const key of keys) expect(rustStrings, `${id}=${key}`).toContain(key);
    }
    const shim = fnBody(mainRs, "shim_question");
    expect(shim).toContain('vec!["desktop", "shim", "install", "--json"]');
    expect(shim).toContain('vec!["desktop", "shim", "install", "--replace", "--json"]');
    expect(shim).toContain('vec!["desktop", "shim", "decline", "--json"]');
    // Keeping a foreign promptgraph is the default.
    expect(shim).toMatch(/ask\(app, "shim-replace", [^;]*&buttons, 0\)/);
    expect(shim).toContain('("keep", "Keep the existing one".to_string()), ("replace"');
  });

  it("passes the repository argument on as an absolute path, even when it does not exist (DESIGN §20.1 item 1)", () => {
    const arg = fnBody(mainRs, "repo_arg");
    // Joined to the caller's directory first (OWD in an AppImage, whose AppRun changes to $APPDIR/usr), so
    // canonicalize never resolves a relative argument against the mount.
    expect(arg).toContain("owd().map_or_else(std::env::current_dir, Ok)");
    expect(arg).toContain("|dir| dir.join(&arg)");
    expect(arg).toMatch(/std::fs::canonicalize\(&path\)\.unwrap_or\(path\)/);
    expect(arg.indexOf("dir.join(&arg)")).toBeLessThan(arg.indexOf("canonicalize"));
    expect(fnBody(mainRs, "main")).toContain("std::env::args_os().nth(1).map(repo_arg)");
  });

  it("never reads the token or the daemon registry", () => {
    for (const [file, src] of Object.entries(rust)) {
      for (const forbidden of ["daemon.json", ".promptgraph", "PG_HOME", "token"]) expect(src.code, `${file}: ${forbidden}`).not.toContain(forbidden);
      expect(src.code, file).not.toMatch(/std::fs::(read|File)|File::open|read_to_string/);
    }
  });
});

describe("window and guards", () => {
  it("builds the main window in code with the guards and the page-load hook", () => {
    const build = fnBody(mainRs, "build_window");
    expect(build).toContain('WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))');
    expect(build).toContain('.title("promptgraph")');
    expect(build).toContain(".inner_size(1280.0, 800.0)");
    expect(build).toContain(".min_inner_size(900.0, 600.0)");
    // The splash keeps the native frame (it has no title bar of its own and no IPC); go() switches to the
    // page's title bar right before navigating, and a splash error restores the frame.
    expect(build).toContain(".decorations(true)");
    expect(build).not.toMatch(/\.decorations\(!/);
    expect(mainRs.code).toMatch(/custom: custom_title_bar\(\)/);
    expect(fnBody(mainRs, "go")).toMatch(/set_decorations\(!shared\.custom\);[\s\S]*window\.navigate\(url\)/);
    expect(fnBody(mainRs, "start_from_splash")).toMatch(/set_decorations\(true\);[\s\S]*__pgSplashError/);
    for (const hook of [".on_navigation(", ".on_new_window(", ".on_page_load("]) expect(build).toContain(hook);
    expect(build).toContain("NewWindowResponse::Deny");
    expect(build).not.toContain("NewWindowResponse::Allow");
    expect(build).toMatch(/PageLoadEvent::Finished\) && is_splash\(/);
    expect(build).toMatch(/initialization_script\(format!\("window\.__PG_DESKTOP__ = Object\.freeze\(\{\{ customTitleBar: \{custom\} \}\}\);"\)\)/);
  });

  it("allows the splash only while the shell shows it, and the allowed origin", () => {
    const build = fnBody(mainRs, "build_window");
    expect(build).toMatch(/if is_splash\(url, &nav\.dev_origin\) \{\s*return nav\.showing_splash\.load\(/);
    expect(build).toMatch(/nav\.origin\.lock\(\)\.unwrap\(\)\.as_deref\(\) == Some\(origin\.as_str\(\)\)/);
    expect(build).toMatch(/url\.scheme\(\) == "https"/);
  });

  it("chooses the decorations from PG_DESKTOP_DECORATIONS, native by default under WSLg", () => {
    const body = fnBody(mainRs, "custom_title_bar");
    expect(body).toContain('std::env::var("PG_DESKTOP_DECORATIONS")');
    expect(body).toContain('Ok("native") => false');
    expect(body).toContain('Ok("custom") => true');
    expect(body).toContain('std::env::var_os("WSL_DISTRO_NAME").is_none()');
  });

  it("reads PG_DESKTOP_ORIGIN only in debug builds", () => {
    const items = topLevelItems(mainRs);
    const using = items.filter((item) => item.text.includes("PG_DESKTOP_ORIGIN"));
    expect(using.length).toBeGreaterThan(0);
    for (const item of using) expect(item.text.trimStart()).toMatch(/^#\[cfg\(debug_assertions\)\]\s*fn /);
    // Every call of the debug-only function is itself compiled only in debug builds.
    const calls = [...mainRs.code.matchAll(/^.*dev_rewrite\(url\).*$/gm)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const before = mainRs.code.slice(0, call.index).trimEnd();
      expect(before.endsWith("#[cfg(debug_assertions)]")).toBe(true);
    }
  });

  it("does not run the CLI from the splash an accepted update shows", () => {
    const build = fnBody(mainRs, "build_window");
    expect(build).toMatch(/load\.splash_loads\.fetch_add\(1, Ordering::SeqCst\);\s*if !load\.restarting\.load\(Ordering::SeqCst\) \{ start_from_splash\(/);
  });

  it("stays small (DESIGN §20.4)", () => {
    expect(rustFiles).toEqual(["dialog.rs", "main.rs", "update.rs"]);
    // Rust unit tests (`#[cfg(test)]`) do not count.
    const lines = (file: string) => read(`src-tauri/src/${file}`).split("#[cfg(test)]")[0]!.split("\n").length;
    expect(lines("main.rs")).toBeLessThan(600);
    expect(lines("dialog.rs") + lines("update.rs")).toBeLessThan(250);
  });
});

describe("Cargo.toml", () => {
  const cargo = read("src-tauri/Cargo.toml");
  it("adds the updater and gtk, and neither the dialog nor the process plugin (DESIGN §20.10)", () => {
    expect(cargo).toMatch(/^tauri-plugin-updater = "~2\.14"$/m);
    expect(cargo).toMatch(/^gtk = "0\.18"$/m);
    const deps = cargo.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(deps.join("\n")).not.toMatch(/tauri-plugin-(dialog|process)/);
  });

  it("pins a tauri 2 minor with on_new_window (>= 2.8) and the README names it", () => {
    const pinned = /^tauri = \{ version = "~2\.(\d+)"/m.exec(cargo);
    expect(pinned).not.toBeNull();
    expect(Number(pinned![1])).toBeGreaterThanOrEqual(8);
    expect(read("README.md")).toContain(`~2.${pinned![1]}`);
    for (const dep of [/^tauri-plugin-opener = "2"/m, /^serde = \{ version = "1", features = \["derive"\] \}/m, /^serde_json = "1"/m, /^libc = "0\.2"/m, /^tauri-build = \{ version = "~2\.7"/m, /^rust-version = "1\.90"/m]) {
      expect(cargo).toMatch(dep);
    }
  });
});

describe("splash", () => {
  const files = listFiles(path.join(root, "splash"));
  it("has no external URLs and defines __pgSplashError with a Retry that reloads", () => {
    expect(files.map((f) => path.basename(f)).sort()).toEqual(["index.html", "splash.js"]);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/https?:\/\/|\bsrc="\/\/|\bhref="|url\(|@import/);
    }
    const html = read("splash/index.html");
    expect(html).toContain("Starting promptgraph…");
    expect(html).toContain('<script src="splash.js"></script>');
    const js = read("splash/splash.js");
    expect(js).toContain("window.__pgSplashError = function (message)");
    expect(js).toContain("window.__pgSplashStatus = function (text)");
    expect(js).toMatch(/getElementById\("status"\)\.textContent = String\(text\)/);
    expect(html).toContain('<p id="status" class="status" role="status">Starting promptgraph…</p>');
    expect(js).toContain("location.reload()");
    expect(js).not.toMatch(/__TAURI__|invoke/);
  });
});

describe("package.json", () => {
  const pkg = JSON.parse(read("package.json")) as { name: string; private: boolean; scripts: Record<string, string>; dependencies?: object; devDependencies?: Record<string, string> };
  it("never builds Rust from pnpm (no build script) and has only workspace devDependencies", () => {
    expect(pkg.name).toBe("@promptgraph/desktop");
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.build).toBeUndefined();
    expect(Object.keys(pkg.scripts).sort()).toEqual(["runtime:prepare", "tauri:build", "tauri:dev", "test", "typecheck"]);
    expect(pkg.scripts["runtime:prepare"]).toBe("node scripts/prepare-runtime.mjs");
    expect(pkg.scripts["tauri:build"]).toBe("pnpm runtime:prepare && cargo tauri build --bundles deb,appimage --config src-tauri/tauri.bundle.conf.json");
    expect(pkg.dependencies).toBeUndefined();
    for (const version of Object.values(pkg.devDependencies ?? {})) expect(version).toMatch(/^workspace:/);
  });
});

describe("bundle overlay (DESIGN §20.4)", () => {
  it("tauri.bundle.conf.json only adds the staged runtime as the runtime/ resource", () => {
    expect(JSON.parse(read("src-tauri/tauri.bundle.conf.json"))).toEqual({ bundle: { resources: { "../runtime-stage/": "runtime/" } } });
  });

  it("tauri.release.conf.json only turns on the updater artifacts (it needs the private key)", () => {
    expect(JSON.parse(read("src-tauri/tauri.release.conf.json"))).toEqual({ bundle: { createUpdaterArtifacts: true } });
  });

  it("tauri.conf.json, which tauri dev uses, has no resources (the stage may not exist)", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as { bundle: Record<string, unknown> };
    expect(conf.bundle.resources).toBeUndefined();
    expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
  });

  it("the stage and private keys are git-ignored, public keys are not", () => {
    const ignore = fs.readFileSync(path.join(root, "..", "..", ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    expect(ignore).toContain("packages/desktop/runtime-stage/");
    expect(ignore).toContain("*.key");
    expect(ignore).toContain("!*.key.pub");
  });
});


describe("updater (DESIGN §20.10)", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as { plugins?: { updater?: { endpoints: string[]; pubkey: unknown; requireSignedVersion: unknown } } };

  it("tauri.conf.json always has plugins.updater with HTTPS endpoints and signed versions required", () => {
    const updater = conf.plugins?.updater;
    expect(updater).toBeDefined();
    expect(Object.keys(updater!).sort()).toEqual(["endpoints", "pubkey", "requireSignedVersion"]);
    expect(updater!.endpoints).toEqual(["https://github.com/luisMDev/promptgraph/releases/latest/download/latest.json"]);
    for (const endpoint of updater!.endpoints) expect(new URL(endpoint).protocol).toBe("https:");
    expect(updater!.requireSignedVersion).toBe(true);
    expect(typeof updater!.pubkey).toBe("string");
  });

  it("update.rs checks only from a release build with a public key, from a .deb or the running AppImage", () => {
    const gate = fnBody(updateRs, "gate");
    expect(gate).toMatch(/^\s*if cfg!\(debug_assertions\) \{ return Err/);
    expect(gate).toContain('app.config().plugins.0.get("updater")');
    expect(gate).toContain("if pubkey.trim().is_empty() { return Err(");
    expect(gate).toContain('std::env::var("PG_DESKTOP_UPDATES").as_deref() == Ok("0")');
    expect(gate).toContain("match bundle_type() {");
    expect(gate).toContain("Some(BundleType::Deb) => Ok(()),");
    expect(gate).toMatch(/Some\(BundleType::AppImage\) => \{[\s\S]*std::env::current_exe\(\)[\s\S]*appimage_is_self\([\s\S]*libc::getuid\(\)/);
    expect(gate).toContain('_ => Err("not running from a .deb or an AppImage".into()),');
    const self_ = fnBody(updateRs, "appimage_is_self");
    expect(self_).toMatch(/^\s*let appdir = crate::appdir_of\(env, exe\)\?;/);
    for (const needle of ['env("APPIMAGE")', "appdir.parent()", '".mount_"', '"appimage_extracted_"', "image.is_absolute()", "symlink_metadata(&image)", "is_file()", "meta.uid() != uid", '"promptgraph"', "to_ascii_lowercase()"]) {
      expect(self_, needle).toContain(needle);
    }
    const spawn = fnBody(updateRs, "spawn");
    expect(spawn).toMatch(/if let Err\(reason\) = gate\(app\) \{\s*eprintln!/);
    expect(spawn).toMatch(/app\.updater_builder\(\)\.timeout\(Duration::from_secs\(30\)\)\s*\.configure_client\(\|client\| client\.read_timeout\(STALL_TIMEOUT\)\)\.build\(\)/);
    expect(updateRs.code).toContain("const STALL_TIMEOUT: Duration = Duration::from_secs(60);");
    expect(spawn).toContain("updater.check()");
    expect(updateRs.code).toContain("const FIRST_CHECK: Duration = Duration::from_secs(5);");
    expect(updateRs.code).toContain("const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);");
    expect(fnBody(mainRs, "main")).toMatch(/build_window\(app\.handle\(\), shared\)\?;\s*update::spawn\(app\.handle\(\)\);/);
  });

  it("asks before downloading, shows progress on the splash and restarts without the process plugin", () => {
    const offer = fnBody(updateRs, "offer");
    expect(offer).toMatch(/match ask\(app, "update", [^;]*\{\s*Some\("update"\) => \{\}\s*Some\(_\) => \{ declined\.insert\(version\); return; \}\s*None => return,/);
    expect(offer).toContain("Release notes (from GitHub):");
    expect(offer).toMatch(/plain_text\(update\.body[^;]*\.take\(NOTES_MAX_CHARS\)/);
    expect(updateRs.code).toContain("const NOTES_MAX_CHARS: usize = 600;");
    expect(offer).toMatch(/shared\.cli\.lock\(\)[\s\S]*shared\.restarting\.store\(true[\s\S]*show_splash\(app, &shared\)[\s\S]*download_and_install\(/);
    expect(offer).toContain('"__pgSplashStatus"');
    // Not AppHandle::restart(): the shell starts the binary tauri would restart (the AppImage file the update
    // replaced, or the .deb's executable) itself, with this process's arguments and a cleaned environment.
    const installed = /Ok\(\(\)\) => \{([\s\S]*?)\n {8}\}/.exec(offer)?.[1] ?? "";
    // A relaunch that fails is shown, not just logged on stderr nobody sees; the app exits either way.
    expect(installed).toMatch(/^\s*if let Err\(e\) = relaunch\(app\) \{[\s\S]*ask\(app, "restart-failed", [^;]*&\[\("ok", "OK"\.to_string\(\)\)\], 0\);\s*\}\s*app\.exit\(0\);$/);
    expect(installed).toContain("is installed, but the app could not start it");
    const relaunch = fnBody(updateRs, "relaunch");
    expect(relaunch).toContain("let binary = tauri::process::current_binary(&env).map_err(|e| e.to_string())?;");
    expect(relaunch).toMatch(/crate::strip_env\(cmd\.args\(env\.args_os\.iter\(\)\.skip\(1\)\), false\);/);
    expect(relaunch).toMatch(/cmd\.spawn\(\)\.map\(drop\)\.map_err\(\|e\| e\.to_string\(\)\)\s*$/);
    expect(relaunch).not.toContain("unwrap_or_default()");
    // Inherited descriptors (the AppImage runtime's handle on this mount) are closed at exec, not before it,
    // so the spawn's own error pipe keeps working.
    expect(relaunch).toContain("cmd.pre_exec(|| { libc::syscall(libc::SYS_close_range, 3, u32::MAX, libc::CLOSE_RANGE_CLOEXEC); Ok(()) })");
    expect(updateRs.code).not.toMatch(/\.restart\(\)/);
    expect(offer).toMatch(/ask\(app, "update-failed"[\s\S]*shared\.restarting\.store\(false/);
    expect(fnBody(updateRs, "show_splash")).toMatch(/showing_splash\.store\(true[\s\S]*window\.navigate\(/);
  });
});

describe("dialogs (DESIGN §20.10)", () => {
  it("are plain-text GTK message dialogs on the main thread, one at a time, with a default on any failure", () => {
    const ask = fnBody(dialogRs, "ask");
    expect(ask).toContain(".use_markup(false).secondary_use_markup(false)");
    expect(ask).toContain(".transient_for(&parent).modal(true)");
    expect(ask).toContain("app.run_on_main_thread(move ||");
    expect(ask).toContain("ONE_AT_A_TIME.lock()");
    expect(ask).toContain("gtk::ResponseType::Other(i as u16)");
    expect(ask).toMatch(/connect_response\([\s\S]*tx\.send\([\s\S]*dialog\.close\(\)/);
    // Escape or closing answers the default; a dialog that was never shown answers None (nothing recorded).
    expect(ask).toContain("shown.ok().and_then(|()| rx.recv().ok()).map(key_at)");
    expect(ask).toContain("if let gtk::ResponseType::Other(i) = response { usize::from(i) } else { default }");
    expect(ask).toMatch(/plain_text\(title\), plain_text\(text\)/);
    expect(ask).toMatch(/debug_assert_ne!\(std::thread::current\(\)\.name\(\), Some\("main"\)/);
    // PG_DESKTOP_AUTO_ANSWER first, logged on stderr.
    expect(ask).toMatch(/AUTO_ANSWERS\.get\(\)[\s\S]*eprintln!\("promptgraph-desktop: auto-answered \{id\}=[\s\S]*ONE_AT_A_TIME/);
    expect(fnBody(dialogRs, "init")).toContain('std::env::var("PG_DESKTOP_AUTO_ANSWER")');
    expect(fnBody(dialogRs, "plain_text")).toContain("*c == '\\n' || !c.is_control()");
    for (const src of Object.values(rust)) expect(src.code).not.toMatch(/set_markup|with_markup|secondary_markup/);
  });
});

describe("key material (DESIGN §20.11)", () => {
  it("no tracked or untracked file of the repository carries an updater private key", () => {
    const repoRoot = path.resolve(root, "..", "..");
    const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8" });
    const files = listed.split("\0").filter(Boolean).map((f) => path.join(repoRoot, f));
    expect(files.length).toBeGreaterThan(100);
    expect(filesWithKeyMaterial(files)).toEqual([]);
  });

  it("the scanner flags a key file, plain or base64", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-key-scan-"));
    try {
      const minisign = "untrusted comment: " + "minisign encrypted secret key\nRWRTY0Iy" + "A".repeat(40) + "\n";
      const rsign = "untrusted comment: " + "rsign encrypted secret key\nRWRTY0Iy" + "B".repeat(40) + "\n";
      const files = {
        plain: minisign,
        tauri: Buffer.from(rsign).toString("base64"),
        minisignBase64: Buffer.from(minisign).toString("base64"),
        clean: "untrusted comment: " + "minisign public key: 0123\n",
      };
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
      const flagged = filesWithKeyMaterial(Object.keys(files).map((name) => path.join(dir, name))).map((f) => path.basename(f));
      expect(flagged.sort()).toEqual(["minisignBase64", "plain", "tauri"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The release workflow (DESIGN §20.11), read as text. A YAML document is split into blocks by indentation
 * (no YAML dependency): a block starts at a line with exactly `indent` spaces and a key (or `- ` for a list
 * item) and runs until the next such line or a line indented less.
 */
interface YamlBlock {
  /** The key of the first line (`- uses: x` → "uses"), or "" for a bare `-`. */
  key: string;
  /** The first line, trimmed. */
  head: string;
  lines: string[];
  text: string;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Drops full-line comments and blank lines, keeping trailing comments (the `uses:` version comments). */
function yamlLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

function yamlBlocks(lines: string[], indent: number, item = false): YamlBlock[] {
  const blocks: YamlBlock[] = [];
  const startsBlock = (line: string) => indentOf(line) === indent && (item ? line.trimStart().startsWith("-") : !line.trimStart().startsWith("-"));
  for (const line of lines) {
    if (indentOf(line) < indent) break;
    if (startsBlock(line)) {
      const head = line.trim();
      const key = /^(?:-\s*)?([A-Za-z_][\w-]*):/.exec(head)?.[1] ?? "";
      blocks.push({ key, head, lines: [line], text: line });
    } else if (blocks.length > 0) {
      const last = blocks[blocks.length - 1]!;
      last.lines.push(line);
      last.text += "\n" + line;
    }
  }
  return blocks;
}

/** The lines below the `key:` line of a block, at deeper indentation. */
function yamlChild(block: YamlBlock | undefined, key: string): string[] {
  if (!block) return [];
  const at = block.lines.findIndex((line) => new RegExp(`^(?:-\\s*)?${key}:`).test(line.trim()));
  if (at === -1) return [];
  const base = indentOf(block.lines[at]!) + (block.lines[at]!.trimStart().startsWith("-") ? 2 : 0);
  const out: string[] = [];
  for (const line of block.lines.slice(at + 1)) {
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  return out;
}

/** `key: value` pairs of a flat mapping (the lines of yamlChild). */
function yamlMap(lines: string[]): Record<string, string> {
  return Object.fromEntries(
    lines.map((line) => {
      const at = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!at) throw new Error(`not a mapping line: ${line}`);
      return [at[1]!, at[2]!];
    }),
  );
}

describe("release workflow (DESIGN §20.11)", () => {
  const TOOLS_STEP = "bash packages/desktop/scripts/appimage-tools.sh";
  const repoRoot = path.resolve(root, "..", "..");
  const lines = yamlLines(fs.readFileSync(path.join(repoRoot, ".github/workflows/release-desktop.yml"), "utf8"));
  /** The workflow without its full-line comments. */
  const raw = lines.join("\n");
  const top = yamlBlocks(lines, 0);
  const topKey = (key: string) => top.find((b) => b.key === key);
  const jobsBlock = topKey("jobs")!;
  const jobs = yamlBlocks(jobsBlock.lines.slice(1), 2);
  const job = (name: string) => jobs.find((j) => j.key === name)!;
  const steps = (name: string) => yamlBlocks(yamlChild(job(name), "steps"), 6, true);
  const jobKeys = (name: string) => yamlBlocks(job(name).lines.slice(1), 4).map((b) => b.key);
  const jobKey = (name: string, key: string) => yamlBlocks(job(name).lines.slice(1), 4).find((b) => b.key === key);
  const usesOf = (step: YamlBlock) => /\buses:\s*([^@\s]+)@/.exec(step.text)?.[1];
  const tauriActionStep = (name: string) => {
    const found = steps(name).filter((s) => usesOf(s) === "tauri-apps/tauri-action");
    expect(found, name).toHaveLength(1);
    return found[0]!;
  };
  const withOf = (step: YamlBlock) => yamlMap(yamlChild(step, "with").filter((line) => /^\s*[A-Za-z_][\w-]*:/.test(line) && indentOf(line) === 10));

  it("is split into the expected top-level keys and the jobs build and release", () => {
    expect(top.map((b) => b.key)).toEqual(["name", "on", "permissions", "concurrency", "jobs"]);
    expect(topKey("name")!.head).toBe("name: Release desktop app");
    expect(jobs.map((j) => j.key)).toEqual(["build", "release"]);
    expect(steps("build").length).toBeGreaterThan(8);
    expect(steps("release").length).toBeGreaterThan(6);
  });

  it("triggers on desktop-v* tags and manual runs only", () => {
    const on = topKey("on")!;
    expect(yamlBlocks(on.lines.slice(1), 2).map((b) => b.key)).toEqual(["push", "workflow_dispatch"]);
    expect(yamlChild(on, "push").map((l) => l.trim())).toEqual(["tags: ['desktop-v*']"]);
  });

  it("grants nothing at the top, and never cancels a running release", () => {
    expect(topKey("permissions")!.lines).toEqual(["permissions: {}"]);
    expect(yamlMap(yamlChild(topKey("concurrency"), "concurrency"))).toEqual({ group: "release-desktop-${{ github.ref }}", "cancel-in-progress": "false" });
  });

  it("build reads contents only, has no environment and never references a secret", () => {
    expect(yamlMap(yamlChild(jobKey("build", "permissions"), "permissions"))).toEqual({ contents: "read" });
    expect(jobKeys("build")).not.toContain("environment");
    expect(jobKeys("build")).not.toContain("env");
    expect(job("build").text).not.toMatch(/secrets\./);
    expect(job("build").text).not.toMatch(/GITHUB_TOKEN|TAURI_SIGNING/);
  });

  it("release runs only for a pushed desktop-v tag, in the desktop-release environment, with contents: write only", () => {
    const head = Object.fromEntries(yamlBlocks(job("release").lines.slice(1), 4).filter((b) => b.lines.length === 1).map((b) => [b.key, b.head.slice(b.key.length + 1).trim()]));
    expect(head.needs).toBe("build");
    expect(head.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/desktop-v')");
    expect(head.environment).toBe("desktop-release");
    expect(yamlMap(yamlChild(jobKey("release", "permissions"), "permissions"))).toEqual({ contents: "write" });
    expect(jobKeys("release")).not.toContain("env");
  });

  it("both jobs run on ubuntu-22.04 with a 60 minute timeout", () => {
    for (const name of ["build", "release"]) {
      expect(job(name).text, name).toContain("\n    runs-on: ubuntu-22.04");
      expect(job(name).text, name).toContain("\n    timeout-minutes: 60");
    }
  });

  it("references secrets only in the env of the release job's tauri-action step, never in a script", () => {
    const step = tauriActionStep("release");
    expect(yamlMap(yamlChild(step, "env"))).toEqual({
      GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    });
    const total = raw.split("secrets.").length - 1;
    expect(total).toBe(3);
    expect(yamlChild(step, "env").join("\n").split("secrets.").length - 1).toBe(3);
    // No script mentions the signing variables, so none can echo them.
    for (const name of ["build", "release"]) {
      for (const s of steps(name)) {
        const run = yamlChild(s, "run").join("\n") + (/\brun:\s*(\S.*)$/m.exec(s.text)?.[1] ?? "");
        expect(run, s.head).not.toMatch(/TAURI_SIGNING|GITHUB_TOKEN|secrets\./);
      }
    }
    expect(raw).not.toMatch(/echo[^\n]*(TAURI_SIGNING|secrets\.)/);
  });

  it("uses no cache of any kind", () => {
    for (const line of raw.split("\n")) {
      if (line.trim() === "package-manager-cache: false") continue; // turns setup-node's automatic cache off
      expect(line).not.toMatch(/cache/i);
    }
    expect(raw).toContain("package-manager-cache: false");
    expect(raw).not.toMatch(/rust-cache|cache-bin|actions\/cache/);
  });

  it("pins every action to a full commit SHA with a version comment", () => {
    const uses = raw.split("\n").filter((line) => /^\s*(-\s*)?uses:/.test(line));
    expect(uses.length).toBe(steps("build").filter(usesOf).length + steps("release").filter(usesOf).length);
    for (const line of uses) {
      expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # \S/);
      if (!line.includes("dtolnay/rust-toolchain@")) expect(line).toMatch(/@[0-9a-f]{40} # (action-)?v\d+\.\d+\.\d+$/);
    }
  });

  it("pins the Rust toolchain and installs tauri-cli 2.12.4 --locked in both jobs", () => {
    for (const name of ["build", "release"]) {
      const rust = steps(name).filter((s) => usesOf(s) === "dtolnay/rust-toolchain");
      expect(rust, name).toHaveLength(1);
      expect(withOf(rust[0]!)).toEqual({ toolchain: "1.99.0" });
      expect(steps(name).filter((s) => s.text.includes("run: cargo install tauri-cli --version 2.12.4 --locked")), name).toHaveLength(1);
    }
    const rustVersion = /^rust-version = "(\d+)\.(\d+)"/m.exec(read("src-tauri/Cargo.toml"))!;
    expect(99).toBeGreaterThanOrEqual(Number(rustVersion[2]));
    expect(raw).not.toMatch(/cargo install(?![^\n]*--locked)/);
  });

  it("checks out without persisted credentials and installs the same apt packages in both jobs", () => {
    const apt = "sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf xdg-utils file build-essential python3";
    for (const name of ["build", "release"]) {
      const first = steps(name)[0]!;
      expect(usesOf(first), name).toBe("actions/checkout");
      expect(withOf(first)).toEqual({ "persist-credentials": "false" });
      expect(job(name).text.split(apt).length - 1, name).toBe(1);
    }
  });

  it("build installs, tests and stages the runtime with the bundled Node, then builds unsigned bundles", () => {
    const build = steps("build");
    const order = (needle: string) => build.findIndex((s) => s.text.includes(needle));
    const node = build.find((s) => usesOf(s) === "actions/setup-node")!;
    expect(withOf(node)).toEqual({ "node-version": NODE_VERSION_PINNED, "package-manager-cache": "false" });
    expect(build.some((s) => usesOf(s) === "pnpm/action-setup")).toBe(true);
    const install = "pnpm install --frozen-lockfile --filter . --filter @promptgraph/shared --filter @promptgraph/server --filter @promptgraph/web --filter @promptgraph/desktop";
    const guard = build.find((s) => s.head === "- name: Guards")!;
    expect(guard.text).toContain("set -euo pipefail");
    expect(guard.text).toContain('"${GITHUB_REF_NAME#desktop-v}" != "$version"');
    expect(guard.text).toContain("require('./$conf').version");
    expect(guard.text).toContain("require('./$conf').plugins.updater.pubkey");
    expect(guard.text).toMatch(/\n {10}pnpm --filter @promptgraph\/desktop test$/);
    const pack = build.find((s) => s.text.includes("id: stage"))!;
    expect(pack.text).toContain("tar -C packages/desktop -cJf runtime-stage.tar.xz runtime-stage");
    expect(pack.text).toContain('>> "$GITHUB_OUTPUT"');
    expect(yamlMap(yamlChild(jobKey("build", "outputs"), "outputs"))).toEqual({ stage_sha256: "${{ steps.stage.outputs.sha256 }}" });
    const upload = build.find((s) => usesOf(s) === "actions/upload-artifact")!;
    expect(withOf(upload)).toMatchObject({ name: "runtime-stage", path: "runtime-stage.tar.xz", "retention-days": "1" });
    const tauri = tauriActionStep("build");
    expect(withOf(tauri)).toEqual({
      projectPath: "packages/desktop",
      tauriScript: "cargo tauri",
      args: "--bundles deb,appimage --config src-tauri/tauri.bundle.conf.json -- --locked",
      uploadWorkflowArtifacts: "true",
    });
    expect(yamlChild(tauri, "env")).toEqual([]);
    const sequence = [install, "- name: Guards", "runtime:prepare", "id: stage", "actions/upload-artifact@", TOOLS_STEP, "tauri-apps/tauri-action@"].map(order);
    expect(order(TOOLS_STEP)).toBe(order("tauri-apps/tauri-action@") - 1);
    expect(sequence.every((i) => i >= 0)).toBe(true);
    expect([...sequence].sort((a, b) => a - b)).toEqual(sequence);
  });

  it("release installs no Node package, verifies the stage and warms up without secrets before signing", () => {
    const release = steps("release");
    expect(job("release").text).not.toMatch(/pnpm|npm |npx|setup-node|action-setup/);
    const download = release.find((s) => usesOf(s) === "actions/download-artifact")!;
    expect(withOf(download)).toEqual({ name: "runtime-stage" });
    const unpack = release.find((s) => s.text.includes("sha256sum -c"))!;
    expect(yamlMap(yamlChild(unpack, "env"))).toEqual({ STAGE_SHA256: "${{ needs.build.outputs.stage_sha256 }}" });
    expect(unpack.text).toContain('echo "$STAGE_SHA256  runtime-stage.tar.xz" | sha256sum -c');
    expect(unpack.text).toContain("tar -C packages/desktop -xJf runtime-stage.tar.xz");
    const tools = release.find((s) => s.text.includes(TOOLS_STEP))!;
    expect(yamlChild(tools, "env")).toEqual([]);
    const warm = release.find((s) => s.text.includes("--no-bundle"))!;
    expect(warm.text).toContain("working-directory: packages/desktop");
    expect(warm.text).toContain("run: cargo tauri build --no-bundle --config src-tauri/tauri.bundle.conf.json --config src-tauri/tauri.release.conf.json -- --locked");
    expect(yamlChild(warm, "env")).toEqual([]);
    const tauri = tauriActionStep("release");
    const index = (s: YamlBlock) => release.indexOf(s);
    expect(index(download)).toBeLessThan(index(unpack));
    expect(index(unpack)).toBeLessThan(index(tools));
    // The AppImage tools are in place and verified before the key exists, so the signing step downloads nothing.
    expect(index(tools)).toBe(index(warm) - 1);
    const signing = release.findIndex((s) => usesOf(s) === "tauri-apps/tauri-action");
    expect(index(warm)).toBe(signing - 1);
    expect(signing).toBe(release.length - 1);
    const inputs = withOf(tauri);
    expect(inputs).toMatchObject({
      projectPath: "packages/desktop",
      tauriScript: "cargo tauri",
      args: "--bundles deb,appimage --config src-tauri/tauri.bundle.conf.json --config src-tauri/tauri.release.conf.json -- --locked",
      tagName: "${{ github.ref_name }}",
      releaseName: "promptgraph desktop v__VERSION__",
      releaseBody: "|",
      releaseDraft: "true",
      prerelease: "false",
      uploadUpdaterJson: "true",
      retryAttempts: "1",
    });
    const body = yamlChild(tauri, "releaseBody").join("\n");
    for (const needle of ["packages/desktop/README.md", "`git`", "`claude`", "`curl`", "`gh`"]) expect(body).toContain(needle);
  });

  it("fetches every AppImage tool the bundler and appimagetool would download, pinned by SHA-256 (DESIGN §17 D13)", () => {
    for (const name of ["build", "release"]) {
      const found = steps(name).filter((s) => s.text.includes(TOOLS_STEP));
      expect(found, name).toHaveLength(1);
      expect(found[0]!.text, name).toContain(`run: ${TOOLS_STEP}`);
    }
    const script = fs.readFileSync(path.join(root, "scripts/appimage-tools.sh"), "utf8");
    expect(script).toContain("set -euo pipefail");
    const pins = [...script.matchAll(/^\s*"([^|"]+)\|(https:\/\/[^|"]+)\|([0-9a-f]{64})\|([0-9a-f]{64}|-)"$/gm)].map((m) => ({ name: m[1]!, url: m[2]! }));
    // The file names tauri-bundler 2.10.4 (tauri-cli 2.12.4) looks up in its tool directory, and the runtime.
    expect(pins.map((p) => p.name)).toEqual(["AppRun-x86_64", "linuxdeploy-07333c6-x86_64.AppImage", "linuxdeploy-plugin-appimage.AppImage", "appimage-runtime-20251108-x86_64"]);
    expect(pins.find((p) => p.name.startsWith("appimage-runtime"))!.url).toBe("https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64");
    for (const { url } of pins) expect(url).toMatch(/^https:\/\/github\.com\/(tauri-apps\/binary-releases|linuxdeploy\/linuxdeploy-plugin-appimage|AppImage\/type2-runtime)\/releases\/download\//);
    expect(script).toContain('dir="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"');
    expect(script).toMatch(/if \[\[ "\$got" != "\$want" \]\]; then[\s\S]*exit 1/);
    expect(script).toContain("curl --proto '=https' --tlsv1.2 -fsSL");
    expect(script).toContain('echo "LDAI_RUNTIME_FILE=$runtime" >>"$GITHUB_ENV"');
    expect(script.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n")).not.toMatch(/TAURI_SIGNING|secrets/);
  });

  it("builds every crate from the committed Cargo.lock (--locked is forwarded to cargo build)", () => {
    const builds = raw.split("\n").filter((line) => /cargo tauri build|^\s*args: --bundles/.test(line));
    expect(builds).toHaveLength(3);
    for (const line of builds) expect(line).toMatch(/ -- --locked$/);
  });

  it("uses the signing overlay only in the release job", () => {
    expect(job("build").text).not.toContain("tauri.release.conf.json");
    expect(job("release").text.split("tauri.release.conf.json").length - 1).toBe(2);
  });
});

describe("README (DESIGN §20.11)", () => {
  const readme = read("README.md");
  it("documents the key, environment, secrets and ruleset commands the maintainer runs", () => {
    for (const command of [
      "cargo tauri signer generate -w ~/.tauri/promptgraph.key",
      "plugins.updater.pubkey",
      "gh api -X PUT repos/luisMDev/promptgraph/environments/desktop-release",
      "gh api user --jq .id",
      '"custom_branch_policies": true',
      "gh api -X POST repos/luisMDev/promptgraph/environments/desktop-release/deployment-branch-policies -f name='desktop-v*' -f type=tag",
      "gh api -X POST repos/luisMDev/promptgraph/rulesets --input",
      '"include": ["refs/tags/desktop-v*"]',
      "gh secret set TAURI_SIGNING_PRIVATE_KEY --env desktop-release --repo luisMDev/promptgraph < ~/.tauri/promptgraph.key",
      "gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env desktop-release --repo luisMDev/promptgraph\n",
      "node scripts/set-version.mjs X.Y.Z",
      "git tag desktop-vX.Y.Z",
      "SHASUMS256.txt",
      "make_latest: false",
      "/mcp",
      "promptgraph desktop shim uninstall --json",
      "cargo install tauri-cli --version 2.12.4 --locked",
      "scripts/appimage-tools.sh",
      "LDAI_RUNTIME_FILE",
    ]) {
      expect(readme, command).toContain(command);
    }
  });

  it("lists every variable the shell reads", () => {
    const vars = new Set(rustStrings.filter((s) => /^(PG_DESKTOP_[A-Z_]+|PROMPTGRAPH_BIN)$/.test(s)));
    expect(vars.size).toBeGreaterThanOrEqual(5);
    for (const name of vars) expect(readme, name).toContain(`| \`${name}\` |`);
    for (const id of Object.keys(DESKTOP_DIALOGS)) expect(readme, id).toContain(`\`${id}\``);
  });
});
