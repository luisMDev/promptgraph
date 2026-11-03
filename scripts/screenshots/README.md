# UI screenshots

`capture.mjs` regenerates the screenshots in `docs/screenshots/` (dark theme, 1600x900, scale 1). It:

1. creates a throwaway `demo-app` git repository in a temp dir, with a local bare repo as `origin`;
2. starts the built server (`packages/server/dist/cli/index.js --no-open`) on a free port, with a temp
   `PG_HOME`, `CLAUDE_CONFIG_DIR` and git config, the fake claude (`PG_CLAUDE_BIN`) and the fake gh
   (`PG_GH_BIN`, `FAKE_GH_URL=https://github.com/acme/demo-app/pull/42`);
3. saves three demo graphs through the REST API (`Add feature`, `Ship feature`, `Test-fix loop`) and turns
   desktop notifications off;
4. drives the UI with Playwright (Run button, node clicks, approval dialogs, terminal input) and waits for
   real node states (REST API plus the node card text) before each screenshot;
5. stops the server and removes the temp dir.

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
| `--scene a,b` | Only these scenes: `add-feature` (m2-*), `ship-feature` (m4-*, run-report), `test-fix` (m6-*) |
| `--keep` | Keep the temp dir (demo repo, `PG_HOME`, worktrees) and print its path |
| `PG_SHOTS_CHROME` | Browser executable |
| `PLAYWRIGHT_CORE` | Directory where `playwright-core` is installed |

A full run takes about two minutes. On failure the script prints the server output and saves the page as
`$TMPDIR/pg-shots-failure.png`.

`m2-real-claude-replay.png` is not generated: it needs the real Claude Code.
