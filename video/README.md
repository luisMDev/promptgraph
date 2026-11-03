# Launch video

A ~36 s product video for X (1920x1080, 30 fps, H.264, no audio: X autoplays muted, so the story is told in
on-screen text). Built with [Remotion](https://www.remotion.dev) from a real recording of the app.

## 1. Record the footage

```bash
pnpm install && pnpm build    # the recorder drives the built server
PLAYWRIGHT_CORE=/tmp/pw node video/scripts/record.mjs
```

`scripts/record.mjs` runs the "Ship /health" graph (plan → three parallel lanes → merge → commit → review gate
→ draft PR) against a throwaway demo repository and records a Chromium screencast (1280x720 UI at 1.5x =
1920x1080 frames) into `public/recording/` (git-ignored), with timestamps for each story beat.

- The prompt steps run the **real Claude Code** with `haiku` and one-line prompts (a few cents), using a temp
  copy of `~/.claude.json` and `~/.claude/.credentials.json` that is deleted at the end. Pass `--fake-claude`
  for a free dry run with the test fake (set `FAKE_CLAUDE_MODE='[[sleep:4000]]'` so the lanes visibly run).
- Pull requests go to the fake `gh`: nothing is pushed anywhere.
- Playwright and the browser are set up as for the screenshots (`scripts/screenshots/README.md`).
- `--keep` keeps the temp dir; `PG_VIDEO_TIMEOUT_MS` changes how long a step may take.

## 2. Edit and render

```bash
pnpm --filter @promptgraph/video studio    # preview and tweak in the browser
pnpm --filter @promptgraph/video render    # out/promptgraph-launch.mp4
```

`src/Launch.tsx` holds the storyboard: an intro card, six captioned shots cut from the recording markers
(sped-up spans show a "▶▶ N×" chip, zooms ease in and out), and an outro with the repository URL. Add
`--browser-executable <chrome-headless-shell>` to `remotion` commands to use an installed browser instead of
letting Remotion download one.
