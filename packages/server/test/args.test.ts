import { DESKTOP_INSTALL_ARGS, DESKTOP_OPEN_ARGS, VERSION_MISMATCH_POLICIES } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { parseCliArgs, USAGE, UsageError, type CliOptions } from "../src/cli/args.js";

const DEFAULTS: CliOptions = {
  command: "open-repo",
  repoDir: "/work",
  target: null,
  port: null,
  portExplicit: false,
  open: true,
  foreground: false,
  json: false,
  printUrl: false,
  next: null,
  webPort: null,
  force: false,
  all: false,
  help: false,
  version: false,
  onVersionMismatch: null,
  shimAction: null,
  replace: false,
};

const parse = (...argv: string[]) => parseCliArgs(argv, "/work");

describe("parseCliArgs (DESIGN §4)", () => {
  it("applies defaults: bare promptgraph opens the current directory", () => {
    expect(parse()).toEqual(DEFAULTS);
  });

  it("open-repo: repo dir, port, --no-open and --foreground", () => {
    expect(parseCliArgs(["../repo", "--port", "5000", "--no-open", "--foreground"], "/work/x")).toEqual({
      ...DEFAULTS,
      repoDir: "/work/repo",
      port: 5000,
      portExplicit: true,
      open: false,
      foreground: true,
    });
    expect(parse("--port=0")).toMatchObject({ port: 0, portExplicit: true });
    expect(parse("-p", "4800")).toMatchObject({ port: 4800, portExplicit: true });
    expect(parse("/abs/repo")).toMatchObject({ command: "open-repo", repoDir: "/abs/repo" });
  });

  it("recognises every subcommand, only as the first argument", () => {
    expect(parse("daemon", "--port", "4800")).toEqual({ ...DEFAULTS, command: "daemon", port: 4800, portExplicit: true });
    expect(parse("mcp")).toMatchObject({ command: "mcp" });
    expect(parse("ls")).toMatchObject({ command: "ls", json: false });
    expect(parse("ls", "--json")).toMatchObject({ command: "ls", json: true });
    expect(parse("open")).toEqual({ ...DEFAULTS, command: "open" });
    expect(parse("rm", "my-repo-0123abcd")).toMatchObject({ command: "rm", target: "my-repo-0123abcd", force: false });
    expect(parse("close", "../x", "--force")).toMatchObject({ command: "rm", target: "../x", force: true });
    expect(parse("stop")).toEqual({ ...DEFAULTS, command: "stop" });
    expect(parse("token", "rotate")).toEqual({ ...DEFAULTS, command: "token-rotate" });
    expect(parse("sessions")).toMatchObject({ command: "sessions", json: false });
    expect(parse("sessions", "--json")).toMatchObject({ command: "sessions", json: true });
    expect(parse("sessions", "revoke", "0123ABCD")).toMatchObject({ command: "sessions-revoke", target: "0123abcd", all: false });
    expect(parse("sessions", "revoke", "--all")).toMatchObject({ command: "sessions-revoke", target: null, all: true });
  });

  it("a repository named like a command is passed as ./name", () => {
    for (const name of ["daemon", "mcp", "ls", "open", "rm", "close", "stop", "token", "sessions"]) {
      expect(parse(`./${name}`)).toMatchObject({ command: "open-repo", repoDir: `/work/${name}` });
    }
    expect(parse("constructor")).toMatchObject({ command: "open-repo", repoDir: "/work/constructor" });
    expect(() => parse("x", "ls")).toThrow("Unexpected argument: ls");
  });

  it("open: target, --next, --print-url, --json (implies --print-url) and --web-port", () => {
    expect(parse("open", "../repo", "--next", "/r/x-0123abcd/graphs/g", "--print-url", "--web-port", "5173")).toEqual({
      ...DEFAULTS,
      command: "open",
      target: "../repo",
      next: "/r/x-0123abcd/graphs/g",
      printUrl: true,
      webPort: 5173,
    });
    expect(parse("open", "repo-0123abcd", "--json")).toMatchObject({ target: "repo-0123abcd", json: true, printUrl: true });
    expect(parse("open", "--print-url", "--json", "--next=/")).toMatchObject({ target: null, json: true, printUrl: true, next: "/" });
    expect(parse("open", "--web-port=5174")).toMatchObject({ webPort: 5174 });
  });

  it("open: the exact argv of the desktop shell (DESIGN §20.1), with and without --next and a repository", () => {
    expect(parse(...DESKTOP_OPEN_ARGS)).toEqual({ ...DEFAULTS, command: "open", json: true, printUrl: true });
    expect(parse(...DESKTOP_OPEN_ARGS, "/abs/repo")).toMatchObject({ command: "open", target: "/abs/repo", json: true, next: null });
    expect(parse(...DESKTOP_OPEN_ARGS, "--next", "/r/x-0123abcd/runs/r1/nodes/n1", "/abs/repo")).toMatchObject({
      command: "open",
      target: "/abs/repo",
      json: true,
      printUrl: true,
      next: "/r/x-0123abcd/runs/r1/nodes/n1",
    });
  });

  it("open --on-version-mismatch (DESIGN §4.3): every policy, with --json only", () => {
    for (const policy of VERSION_MISMATCH_POLICIES) {
      expect(parse(...DESKTOP_OPEN_ARGS, "--on-version-mismatch", policy)).toEqual({ ...DEFAULTS, command: "open", json: true, printUrl: true, onVersionMismatch: policy });
      expect(parse("open", "--json", `--on-version-mismatch=${policy}`, "/abs/repo")).toMatchObject({ onVersionMismatch: policy, target: "/abs/repo" });
    }
    const bad: Array<[string[], string]> = [
      [["open", "--on-version-mismatch", "auto"], "--on-version-mismatch requires --json"],
      [["open", "--print-url", "--on-version-mismatch", "restart"], "--on-version-mismatch requires --json"],
      [["open", "--json", "--on-version-mismatch", "kill"], "Invalid --on-version-mismatch: kill"],
      [["open", "--json", "--on-version-mismatch"], "Invalid --on-version-mismatch: (missing)"],
      [["ls", "--json", "--on-version-mismatch", "auto"], "Unknown option for ls"],
      [["--on-version-mismatch", "auto"], "Unknown option for promptgraph"],
    ];
    for (const [argv, message] of bad) {
      expect(() => parse(...argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parse(...argv), argv.join(" ")).toThrow(message);
    }
  });

  it("desktop install / desktop shim <action> (internal, DESIGN §20.7, §20.8) require --json", () => {
    expect(parse(...DESKTOP_INSTALL_ARGS)).toEqual({ ...DEFAULTS, command: "desktop-install", json: true });
    for (const action of ["status", "install", "decline", "uninstall"] as const) {
      expect(parse("desktop", "shim", action, "--json")).toEqual({ ...DEFAULTS, command: "desktop-shim", shimAction: action, json: true });
    }
    expect(parse("desktop", "shim", "install", "--replace", "--json")).toMatchObject({ command: "desktop-shim", shimAction: "install", replace: true });
    // A repository named like the command is still a directory.
    expect(parse("./desktop")).toMatchObject({ command: "open-repo", repoDir: "/work/desktop" });
    // `promptgraph desktop [--no-open]` used to open ./desktop: the error says how to do that now.
    for (const argv of [["desktop"], ["desktop", "--no-open"], ["desktop", "run"]]) {
      expect(() => parse(...argv), argv.join(" ")).toThrow("to open a directory named desktop, run promptgraph ./desktop");
    }
    expect(() => parse("desktop", "shim", "delete", "--json")).not.toThrow(/\.\/desktop/);
    const bad: Array<[string[], string]> = [
      [["desktop", "install"], "desktop install requires --json"],
      [["desktop", "shim", "install"], "desktop shim requires --json"],
      [["desktop", "shim", "status", "--replace", "--json"], "--replace is only valid with desktop shim install"],
      [["desktop", "shim", "decline", "--replace", "--json"], "--replace is only valid with desktop shim install"],
      [["desktop", "install", "--replace", "--json"], "Unknown option for desktop install"],
      [["desktop"], "desktop: missing action"],
      [["desktop", "run"], "Unknown desktop action: run"],
      [["desktop", "shim"], "desktop shim: missing action"],
      [["desktop", "shim", "delete", "--json"], "Unknown desktop shim action: delete"],
      [["desktop", "install", "x", "--json"], "Unexpected argument: x"],
      [["desktop", "install", "--port", "1", "--json"], "Unknown option for desktop install"],
    ];
    for (const [argv, message] of bad) {
      expect(() => parse(...argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parse(...argv), argv.join(" ")).toThrow(message);
    }
  });

  it("the desktop commands are not in USAGE", () => {
    expect(USAGE).not.toMatch(/desktop (install|shim)/);
    expect(USAGE).not.toContain("--replace");
  });

  it("--help and --version are global", () => {
    expect(parse("-h", "--version")).toMatchObject({ help: true, version: true });
    expect(parse("mcp", "--help")).toMatchObject({ command: "mcp", help: true });
    expect(parse("rm", "--help")).toMatchObject({ command: "rm", help: true, target: null });
    expect(parse("sessions", "revoke", "-h")).toMatchObject({ command: "sessions-revoke", help: true });
  });

  it("rejects bad input with a UsageError (exit 2)", () => {
    const bad: Array<[string[], string]> = [
      [["--port"], "Invalid port"],
      [["--port", "99999"], "Invalid port"],
      [["--port", "12x"], "Invalid port"],
      [["--bogus"], "Unknown option"],
      [["a", "b"], "Unexpected argument: b"],
      [["mcp", "x"], "Unexpected argument"],
      [["mcp", "--port", "1"], "Unknown option for mcp"],
      [["daemon", "x"], "Unexpected argument"],
      [["daemon", "--foreground"], "Unknown option for daemon"],
      [["daemon", "--no-open"], "Unknown option for daemon"],
      [["ls", "x"], "Unexpected argument"],
      [["ls", "--force"], "Unknown option for ls"],
      [["open", "a", "b"], "Unexpected argument: b"],
      [["open", "--port", "1"], "Unknown option for open"],
      [["open", "--next"], "Invalid --next"],
      [["open", "--next", "//evil.com"], "Invalid --next"],
      [["open", "--next", "https://evil.com"], "Invalid --next"],
      [["open", "--next", "/\\evil"], "Invalid --next"],
      [["open", "--next", "r/x"], "Invalid --next"],
      [["open", "--web-port", "0"], "Invalid web port"],
      [["open", "--web-port"], "Invalid web port"],
      [["rm"], "rm: missing repository"],
      [["close"], "rm: missing repository"],
      [["rm", "a", "b"], "Unexpected argument"],
      [["rm", "x", "--json"], "Unknown option for rm"],
      [["stop", "x"], "Unexpected argument"],
      [["stop", "--force"], "Unknown option for stop"],
      [["token"], "token: missing action"],
      [["token", "show"], "Unknown token action: show"],
      [["token", "rotate", "x"], "Unexpected argument"],
      [["sessions", "x"], "Unexpected argument"],
      [["sessions", "--all"], "Unknown option for sessions"],
      [["sessions", "revoke"], "give one session id or --all"],
      [["sessions", "revoke", "0123abcd", "--all"], "give one session id or --all"],
      [["sessions", "revoke", "xyz"], "Invalid session id"],
      [["sessions", "revoke", "0123abc"], "Invalid session id"],
      [["sessions", "revoke", "all"], "Invalid session id"],
      [["sessions", "revoke", "--json", "--all"], "Unknown option for sessions revoke"],
      [["--no-open", "--json"], "Unknown option for promptgraph"],
    ];
    for (const [argv, message] of bad) {
      expect(() => parse(...argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parse(...argv), argv.join(" ")).toThrow(message);
    }
  });

  it("USAGE lists every command", () => {
    for (const cmd of ["promptgraph [repo-dir]", "daemon", "ls", "open", "rm", "close", "stop", "token rotate", "sessions [--json]", "sessions revoke", "mcp"]) {
      expect(USAGE).toContain(cmd);
    }
    for (const opt of ["--port", "--no-open", "--foreground", "--json", "--next", "--print-url", "--web-port", "--force", "--all", "--on-version-mismatch"]) {
      expect(USAGE).toContain(opt);
    }
  });
});
