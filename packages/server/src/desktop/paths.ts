import path from "node:path";

/** Per-user locations of the desktop app's runtime, prefs and command shim (DESIGN §20.7, §20.8). */
export interface DesktopPaths {
  home: string;
  /** `${XDG_DATA_HOME:-~/.local/share}/promptgraph` (not PG_HOME, which belongs to the daemon). */
  dataDir: string;
  /** `<data>/runtime`, mode 0700: one `<version>-<buildId[:8]>` directory per installed build. */
  runtimeDir: string;
  /** `<data>/runtime/current`: relative symlink to one of them. */
  currentLink: string;
  /** `${XDG_CONFIG_HOME:-~/.config}/promptgraph/desktop.json`. */
  prefsFile: string;
  /** `~/.local/bin`. */
  binDir: string;
  /** `~/.local/bin/promptgraph`. */
  shimPath: string;
}

/** An XDG base directory variable: used only when it is an absolute path (the spec ignores relative ones). */
function xdgDir(value: string | undefined, fallback: string): string {
  return value && path.isAbsolute(value) ? path.resolve(value) : fallback;
}

/**
 * The desktop paths, taken from `env` only (HOME, XDG_DATA_HOME, XDG_CONFIG_HOME), never from
 * `os.homedir()`, so tests point them at temporary directories.
 * @throws when HOME is not set to an absolute path.
 */
export function desktopPaths(env: NodeJS.ProcessEnv): DesktopPaths {
  const home = env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("HOME is not set to an absolute path");
  const dataDir = path.join(xdgDir(env.XDG_DATA_HOME, path.join(home, ".local", "share")), "promptgraph");
  const runtimeDir = path.join(dataDir, "runtime");
  const binDir = path.join(home, ".local", "bin");
  return {
    home: path.resolve(home),
    dataDir,
    runtimeDir,
    currentLink: path.join(runtimeDir, "current"),
    prefsFile: path.join(xdgDir(env.XDG_CONFIG_HOME, path.join(home, ".config")), "promptgraph", "desktop.json"),
    binDir,
    shimPath: path.join(binDir, "promptgraph"),
  };
}
