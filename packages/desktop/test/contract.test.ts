import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_COMMANDS, DESKTOP_OPEN_ARGS, DESKTOP_PERMISSIONS, DESKTOP_STRIPPED_ENV, DESKTOP_STRIPPED_ENV_PREFIXES } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";

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

/** A small Rust lexer: enough to strip comments and find string literals in main.rs/build.rs. */
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

const mainRs = lexRust(read("src-tauri/src/main.rs"));
const buildRs = lexRust(read("src-tauri/build.rs"));
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
    const listed = mainRs.strings.filter((s) => /^(core:|opener:|allow-)/.test(s));
    expect([...listed].sort()).toEqual([...DESKTOP_PERMISSIONS].sort());
    expect(mainRs.code).toMatch(/permission_scoped\(\s*OPENER_PERMISSION/);
    expect(mainRs.strings).toContain("https://*");
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
    const run = fnBody(mainRs, "run_cli");
    expect(run).toContain("let (shell, flags, script) = login_shell();");
    expect(run).toMatch(/\.arg\(flags\)\.arg\(script\)\.arg\(&bin\)\.args\(OPEN_ARGS\)/);
    expect(run).toContain("stdin(Stdio::null())");
  });

  it("uses the POSIX form for POSIX shells, $argv for fish and /bin/sh -l for any other shell", () => {
    const shell = fnBody(mainRs, "login_shell");
    expect(shell).toContain('"sh" | "bash" | "zsh" | "dash" | "ash" | "ksh" | "mksh" => (shell, "-ilc", POSIX_EXEC)');
    expect(shell).toContain('"fish" => (shell, "-ilc", "exec $argv")');
    expect(shell).toContain('_ => ("/bin/sh".into(), "-lc", POSIX_EXEC)');
  });

  it("runs the shell in its own session, kills the whole session on timeout and reads output without waiting for EOF", () => {
    const run = fnBody(mainRs, "run_cli");
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
  });

  it("removes every DESKTOP_STRIPPED_ENV name and prefix", () => {
    for (const name of [...DESKTOP_STRIPPED_ENV, ...DESKTOP_STRIPPED_ENV_PREFIXES]) expect(mainRs.strings, name).toContain(name);
    const run = fnBody(mainRs, "run_cli");
    expect(run).toMatch(/for name in STRIPPED_ENV \{\s*cmd\.env_remove\(name\);/);
    expect(run).toMatch(/STRIPPED_ENV_PREFIXES\.iter\(\)\.any\(\|p\| k\.starts_with\(p\)\)/);
  });

  it("takes the last JSON line, checks v == 1 and maps the splash errors (DESIGN §20.1 item 4)", () => {
    const run = fnBody(mainRs, "run_cli");
    expect(run).toMatch(/\.lines\(\)\s*\.rev\(\)/);
    expect(run).toContain('last.get("v") != Some(&serde_json::json!(1))');
    expect(run).toContain("Some(127) => return Err(NOT_FOUND.into())");
    // stderr also carries the login shell's start-up messages: never guess "not found" from its text.
    expect(run).not.toMatch(/stderr\.contains\(/);
    expect(run).toContain("Some(2) => return Err(version_required())");
    expect(run).toContain("CLI_TIMEOUT");
    expect(mainRs.code).toContain("Duration::from_secs(30)");
    expect(mainRs.strings).toContain("promptgraph CLI not found: install it with `npm i -g promptgraph` or set `PROMPTGRAPH_BIN`");
    expect(mainRs.strings.some((s) => s.startsWith("promptgraph ≥ {} is required"))).toBe(true);
    expect(fnBody(mainRs, "start_from_splash")).toContain("window.__pgSplashError({arg})");
  });

  it("passes the repository argument on as an absolute path, even when it does not exist (DESIGN §20.1 item 1)", () => {
    const arg = fnBody(mainRs, "repo_arg");
    expect(arg).toContain("std::fs::canonicalize(&path)");
    expect(arg).toContain(".or_else(|_| std::env::current_dir().map(|dir| dir.join(&path)))");
    expect(arg).not.toMatch(/unwrap_or\(path\)/);
    expect(fnBody(mainRs, "main")).toContain("std::env::args_os().nth(1).map(repo_arg)");
  });

  it("never reads the token or the daemon registry", () => {
    for (const forbidden of ["daemon.json", ".promptgraph", "PG_HOME", "token"]) {
      expect(mainRs.code, forbidden).not.toContain(forbidden);
    }
    expect(mainRs.code).not.toMatch(/std::fs::(read|File)|File::open|read_to_string/);
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

  it("stays small (DESIGN §20.4)", () => {
    expect(read("src-tauri/src/main.rs").split("\n").length).toBeLessThan(310);
  });
});

describe("Cargo.toml", () => {
  const cargo = read("src-tauri/Cargo.toml");
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
    expect(Object.keys(pkg.scripts).sort()).toEqual(["tauri:build", "tauri:dev", "test", "typecheck"]);
    expect(pkg.scripts["tauri:build"]).toBe("cargo tauri build --bundles deb,appimage");
    expect(pkg.dependencies).toBeUndefined();
    for (const version of Object.values(pkg.devDependencies ?? {})) expect(version).toMatch(/^workspace:/);
  });
});
