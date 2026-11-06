# UI screenshots

`capture.mjs` regenerates the screenshots in `docs/screenshots/` (dark theme, 1600x900, scale 1). It:

1. creates a throwaway `demo-app` git repository in a temp dir, with a local bare repo as `origin`;
2. starts the built daemon in the foreground (`packages/server/dist/cli/index.js <repo> --foreground --no-open
   --port <free port>`; a `--foreground` daemon always keeps the script's environment, and
   `PG_DAEMON_SHELL_ENV=0` is set only as a guard in case it ever starts a background daemon), with a temp `PG_HOME`, `CLAUDE_CONFIG_DIR` and git config, the fake claude
   (`PG_CLAUDE_BIN`) and the fake gh (`PG_GH_BIN`, `FAKE_GH_URL=https://github.com/acme/demo-app/pull/42`). It
   waits for the `Open: http://127.0.0.1:<port>/r/<repoId>` line and reads the daemon's token from
   `<PG_HOME>/token`;
3. talks to the daemon's REST API with that token as a Bearer header: saves three demo graphs under the
   repository (`/api/repos/<repoId>/…`: `Add feature`, `Ship feature`, `Test-fix loop`) and turns desktop
   notifications off;
4. signs the browser in like `promptgraph open` does: it mints a one-time login code
   (`POST /api/daemon/login-codes`, valid once for 30 s) and opens `/login?code=…&next=/r/<repoId>`, which sets
   the session cookie. After that it opens views by their URL (`/r/<repoId>/graphs/<graphId>`);
5. drives the UI with Playwright (Run button, node clicks, approval dialogs, terminal input) and waits for
   real node states (REST API plus the node card text) before each screenshot. Every view the script opens
   by URL becomes a tab, so later screenshots show earlier scenes' tabs in the strip;
6. stops the daemon (SIGINT) and removes the temp dir.

The token is only sent as a header: it never appears in a URL, a log line or a screenshot. `demo-env.mjs` holds
this plumbing (`startServer`, `mintLoginUrl`, `apiClient`) and is shared with `video/scripts/record.mjs`.

It never touches `~/.promptgraph`, `~/.claude.json` or a real repository.

## Setup

Build the workspace once:

```bash
pnpm install && pnpm build
```

Playwright is not a dependency of the repo. Install `playwright-core` in any scratch directory and point
`PLAYWRIGHT_CORE` at it (or make it resolvable from `scripts/screenshots/` some other way):

```bash
mkdir -p /tmp/pw && (cd /tmp/pw && npm init -y >/dev/null && npm i playwright-core)
```

The script does not download a browser. It uses `PG_SHOTS_CHROME`, by default
`~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` (installed by `npx playwright install chromium`).
`chrome-headless-shell` also works but renders small text with uneven letter spacing.

## Run

```bash
PLAYWRIGHT_CORE=/tmp/pw node scripts/screenshots/capture.mjs /tmp/shots
```

The PNGs are written to the output directory, never to `docs/screenshots/` directly: check them, then copy
the ones you want.

| Option / env | Meaning |
| --- | --- |
| `<out-dir>`, `--out <dir>`, `PG_SHOTS_OUT` | Output directory (created if missing) |
| `--scene a,b` | Only these scenes: `add-feature` (m2-*), `ship-feature` (m4-*, run-report), `test-fix` (m6-*), `home` (home.png: Home with a second registered repository) |
| `--keep` | Keep the temp dir (demo repo, `PG_HOME`, worktrees) and print its path |
| `--real-claude` | Only `m2-real-claude-replay.png`, with the real Claude Code (see below) |
| `PG_SHOTS_CHROME` | Browser executable |
| `PLAYWRIGHT_CORE` | Directory where `playwright-core` is installed |
| `PG_SHOTS_CLAUDE` | Claude Code executable for `--real-claude` (default `claude`) |

A full run takes about two minutes. On failure the script prints the server output and saves the page as
`$TMPDIR/pg-shots-failure.png`.

`m2-real-claude-replay.png` needs the real Claude Code, so it is opt-in:

```bash
PLAYWRIGHT_CORE=/tmp/pw node scripts/screenshots/capture.mjs /tmp/shots --real-claude
```

It runs a two-step graph ("Pong smoke": two one-line prompts, model `haiku`) with `claude` from `PATH` (or
`PG_SHOTS_CLAUDE`), logged in as you. The temp `CLAUDE_CONFIG_DIR` gets a copy of `~/.claude.json` and
`~/.claude/.credentials.json`; the credentials copy is deleted at the end, even with `--keep`. The cost is a
fraction of a cent.
