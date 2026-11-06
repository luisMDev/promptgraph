import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonEnv, lastJsonObjectLine, stripRuntimeEnv } from "../src/daemon/daemon-env.js";
import { tempDir } from "./helpers.js";

describe("daemonEnv (DESIGN §4.1 item 5)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  const caller = {
    HOME: "/home/u",
    USER: "u",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_RUNTIME_DIR: "/run/user/1",
    PG_HOME: "/tmp/pg",
    PG_CLAUDE_BIN: "/opt/claude",
    // A node run's hook variables (start_server called from a Claude session promptgraph spawned).
    PG_PORT: "4777",
    PG_HOOK_HEADER_FILE: "/tmp/pg/hooks/nr-1.header",
    PG_NODE_RUN_ID: "nr-1",
    PATH: "/caller/bin:/usr/bin",
    FOO_SECRET: "s3cret",
    LD_LIBRARY_PATH: "/appimage/lib",
    GTK_PATH: "/appimage/gtk",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    VITEST: "true",
  };

  /** A fake $SHELL: ignores its flags, exports a profile variable, prints noise, then runs the -c command. */
  function fakeShell(body = ""): string {
    const { dir, cleanup } = tempDir("pg-fake-shell-");
    cleanups.push(cleanup);
    const file = path.join(dir, "fake-sh");
    fs.writeFileSync(
      file,
      `#!/bin/sh\n# $1 = -ilc, $2 = the command\necho "welcome to the fake shell {not json"\nexport PATH="/profile/bin:$PATH" PROFILE_VAR=from-profile LD_PRELOAD=/evil.so\n${body}\nexec /bin/sh -c "$2"\n`,
      { mode: 0o755 },
    );
    return file;
  }

  it("keeps only allowlisted caller variables and the caller's PATH when the shell is skipped", async () => {
    const env = await daemonEnv({ caller: { ...caller, PG_DAEMON_SHELL_ENV: "0" } });
    expect(env).toEqual({
      HOME: "/home/u",
      USER: "u",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1",
      PG_HOME: "/tmp/pg",
      PG_CLAUDE_BIN: "/opt/claude",
      PG_DAEMON_SHELL_ENV: "0",
      PATH: "/caller/bin:/usr/bin",
    });
    expect(env.FOO_SECRET).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    for (const k of ["PG_PORT", "PG_HOOK_HEADER_FILE", "PG_NODE_RUN_ID"]) expect(env[k], k).toBeUndefined();
  });

  it("keeps the caller's CLAUDE_CONFIG_DIR", async () => {
    const env = await daemonEnv({ caller: { ...caller, PG_DAEMON_SHELL_ENV: "0", CLAUDE_CONFIG_DIR: "/tmp/claude-cfg" } });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-cfg");
  });

  it("merges the login shell's environment, the caller's allowlisted variables winning", async () => {
    const shell = fakeShell();
    const env = await daemonEnv({ caller: { ...caller, SHELL: shell } });
    expect(env.PATH).toBe("/profile/bin:/caller/bin:/usr/bin");
    expect(env.PROFILE_VAR).toBe("from-profile");
    expect(env.PG_HOME).toBe("/tmp/pg");
    expect(env.SHELL).toBe(shell);
    for (const k of ["FOO_SECRET", "LD_LIBRARY_PATH", "LD_PRELOAD", "GTK_PATH", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "VITEST", "PWD", "SHLVL"]) {
      expect(env[k], k).toBeUndefined();
    }
  });

  it("falls back to the caller's PATH when the shell hangs or fails", async () => {
    const hanging = fakeShell("sleep 30");
    const started = Date.now();
    const env = await daemonEnv({ caller: { ...caller, SHELL: hanging }, shellTimeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(env.PATH).toBe("/caller/bin:/usr/bin");
    expect(env.PROFILE_VAR).toBeUndefined();

    const failing = await daemonEnv({ caller: { ...caller, SHELL: "/nonexistent/sh" } });
    expect(failing.PATH).toBe("/caller/bin:/usr/bin");
  });

  it("stripRuntimeEnv drops runtime and Claude nesting variables only", () => {
    expect(stripRuntimeEnv({ A: "1", APPIMAGE: "x", WEBKIT_DISABLE: "1", CLAUDE_CODE_SESSION_ID: "s", MY_HERMETIC_MODE: "1", PG_HOME: "/h" })).toEqual({ A: "1", PG_HOME: "/h" });
  });

  it("stripRuntimeEnv drops PG_DESKTOP_*, GI_* and the AppImage mount entries of XDG_*_DIRS (DESIGN §4.1 item 5)", () => {
    const out = stripRuntimeEnv({
      A: "1",
      PG_HOME: "/h",
      PG_DESKTOP_AUTO_ANSWER: "shim-offer=install",
      PG_DESKTOP_UPDATES: "0",
      PG_DESKTOP_DECORATIONS: "native",
      GI_TYPELIB_PATH: "/tmp/.mount_promptXYZ/usr/lib/girepository-1.0",
      XDG_DATA_DIRS: "/tmp/.mount_promptXYZ/usr/share:/usr/local/share:/usr/share:/tmp/appimage_extracted_1/.mount_x/share",
      XDG_CONFIG_DIRS: "/tmp/.mount_promptXYZ/etc/xdg",
      XDG_RUNTIME_DIR: "/run/user/1",
    });
    expect(out).toEqual({ A: "1", PG_HOME: "/h", XDG_DATA_DIRS: "/usr/local/share:/usr/share", XDG_RUNTIME_DIR: "/run/user/1" });
    // A name that merely contains `.mount_` in the middle of a segment is kept; an empty list is dropped.
    expect(stripRuntimeEnv({ XDG_DATA_DIRS: "/srv/x.mount_y/share", XDG_CONFIG_DIRS: "" })).toEqual({ XDG_DATA_DIRS: "/srv/x.mount_y/share" });
  });

  it("stripRuntimeEnv drops the PATH entries of any AppImage mount, e.g. the previous one after an update restart", () => {
    const out = stripRuntimeEnv({
      PATH: "/tmp/.mount_promptOld123/usr/bin/:/home/u/.local/bin:/tmp/appimage_extracted_ab/usr/bin:/usr/bin:/srv/x.mount_y/bin",
      XDG_DATA_DIRS: "/tmp/appimage_extracted_ab/usr/share:/usr/share",
    });
    expect(out).toEqual({ PATH: "/home/u/.local/bin:/usr/bin:/srv/x.mount_y/bin", XDG_DATA_DIRS: "/usr/share" });
  });

  it("stripRuntimeEnv drops AppRun's PYTHONHOME, PYTHONPATH, PERLLIB, QT_ and GST_ search paths into the mount, keeping the user's", () => {
    const m = "/tmp/.mount_promptAbc123";
    const out = stripRuntimeEnv({
      PYTHONHOME: `${m}/usr/`,
      PYTHONPATH: `${m}/usr/share/pyshared/:/home/u/py`,
      PERLLIB: `${m}/usr/share/perl5/:${m}/usr/lib/perl5/:`,
      QT_PLUGIN_PATH: `${m}/usr/lib/qt5/plugins/`,
      GST_PLUGIN_SYSTEM_PATH: `${m}/usr/lib/gstreamer:`,
      GST_PLUGIN_SYSTEM_PATH_1_0: `${m}/usr/lib/gstreamer-1.0:/usr/lib/x86_64-linux-gnu/gstreamer-1.0`,
    });
    expect(out).toEqual({ PYTHONPATH: "/home/u/py", GST_PLUGIN_SYSTEM_PATH_1_0: "/usr/lib/x86_64-linux-gnu/gstreamer-1.0" });
  });

  it("a detached daemon never gets the desktop variables, even through the PG_ allowlist", async () => {
    const env = await daemonEnv({
      caller: { ...caller, PG_DESKTOP_AUTO_ANSWER: "update=update", GI_TYPELIB_PATH: "/tmp/.mount_a/gi", XDG_DATA_DIRS: "/tmp/.mount_a/share:/usr/share", PATH: "/tmp/.mount_old/usr/bin:/usr/bin" },
      resolveShell: false,
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PG_DESKTOP_AUTO_ANSWER).toBeUndefined();
    expect(env.GI_TYPELIB_PATH).toBeUndefined();
    expect(env.XDG_DATA_DIRS).toBe("/usr/share");
    expect(env.PG_CLAUDE_BIN).toBe("/opt/claude");
  });

  it("takes the last JSON object line of noisy output", () => {
    expect(lastJsonObjectLine('motd\n{"A":"1"}\n{oops\n')).toEqual({ A: "1" });
    expect(lastJsonObjectLine("no json here")).toBeNull();
  });
});
