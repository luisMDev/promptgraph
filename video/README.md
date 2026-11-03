# Launch video

A ~36 s product video for X (1920x1080, 30 fps, H.264 + AAC). X autoplays muted, so the story is told in
on-screen text; the soundtrack is for viewers who unmute. Built with [Remotion](https://www.remotion.dev) from a
real recording of the app.

## 1. Record the footage

```bash
pnpm install && pnpm build    # the recorder drives the built server
PLAYWRIGHT_CORE=/tmp/pw node video/scripts/record.mjs
```

`scripts/record.mjs` runs the "Ship /health" graph (plan → three parallel lanes → merge → commit → review gate
→ draft PR) against a throwaway demo repository and records a Chromium screencast (1280x720 UI at 1.5x =
1920x1080 frames) into `public/recording/` (git-ignored), with timestamps for each story beat, the pointer's
clicks, and the boxes of the regions the video spotlights.

- The prompt steps run the **real Claude Code** with `haiku` and one-line prompts (a few cents), using a temp
  copy of `~/.claude.json` and `~/.claude/.credentials.json` that is deleted at the end. Pass `--fake-claude`
  for a free dry run with the test fake (set `FAKE_CLAUDE_MODE='[[sleep:4000]]'` so the lanes visibly run).
- Pull requests go to the fake `gh`: nothing is pushed anywhere.
- Playwright and the browser are set up as for the screenshots (`scripts/screenshots/README.md`).
- `--keep` keeps the temp dir; `PG_VIDEO_TIMEOUT_MS` changes how long a step may take.

## 2. Sound

`scripts/make-audio.mjs` synthesises the soundtrack from oscillators and noise into `public/audio/`
(git-ignored): a ~40 s music bed in A minor at 100 BPM, a whoosh for the cuts, a click and an outro accent. It
is all generated, so there is nothing to license. `studio` and `render` run it first.

## 3. Edit and render

```bash
pnpm --filter @promptgraph/video studio    # preview and tweak in the browser
pnpm --filter @promptgraph/video render    # out/promptgraph-launch.mp4
```

`src/Launch.tsx` holds the storyboard: an intro card, six captioned shots cut from the recording markers
(sped-up spans show a "▶▶ N×" chip; a spotlight dims the window around the lanes and the terminal, the
footage is never cropped), an outro with the repository URL, and the soundtrack (music fading in and out, a
whoosh on every cut, a click on every recorded pointer click). Add
`--browser-executable <chrome-headless-shell>` to `remotion` commands to use an installed browser instead of
letting Remotion download one.
