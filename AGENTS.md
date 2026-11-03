# AGENTS.md

Guidance for coding agents (Claude Code, Codex, etc.) working in this repository.

## Project

`promptgraph` is a local tool: one background daemon per user, bound to `127.0.0.1`, manages many git repositories and serves a React UI (in the browser or a Tauri desktop window). `promptgraph [repo-dir]` registers a repository with the daemon (starting it if needed) and opens it. The user draws a graph where each node is a step — a Claude Code prompt, a slash command, a shell command, a commit, a PR, an approval, a merge — and runs it. Independent branches run in parallel, each in its own git worktree. Clicking a node opens the real, interactive Claude Code terminal of that step.

**The source of truth for behaviour and architecture is [`docs/DESIGN.md`](docs/DESIGN.md).** Read the relevant sections before implementing anything. If an implementation needs to diverge from the design, update `docs/DESIGN.md` in the same change and explain why.

## Status

Milestones M0–M6 are implemented (`docs/CONTRACTS.md` documents the module boundaries). M7 (daemon managing many repositories), M8 (router, Home, in-app tabs) and M9 (Tauri desktop shell) are designed in `docs/DESIGN.md` §4, §11–§14, §19 and §20.

## Stack

- Node 22, TypeScript (strict), pnpm workspace
- Server: Hono + `ws`, `node-pty`, `better-sqlite3`, `zod`
- Web: React 19, Vite, `@xyflow/react`, `@xterm/xterm`, `zustand`, Tailwind v4, shadcn/ui (Radix primitives via `radix-ui`; vendored in `packages/web/src/components/ui`, app-level wrappers in `components/common/ui.tsx`); hand-written router in `packages/web/src/lib/router` (no router dependency)
- Desktop: Tauri v2 (Rust, Linux/WebKitGTK) in `packages/desktop`; no npm Tauri packages. Rust cannot be built on every development machine, so keep `src-tauri` free of logic and test its contract from TypeScript (DESIGN §20.5)

## Layout

```
packages/
  shared/   # zod schemas, TS types, WebSocket protocol — imported by server and web
  server/   # CLI entry (bin: promptgraph), engine, runners, workspaces, store, HTTP/WS
  web/      # React app; built assets are served by the daemon
  desktop/  # Tauri v2 shell (src-tauri, splash, TS contract tests); no `build` script, Rust only via tauri:dev/tauri:build
site/       # Astro landing page, deployed to GitHub Pages by .github/workflows/pages.yml
video/      # Remotion launch video, recorded from the real app (video/README.md)
scripts/screenshots/  # docs screenshots (capture.mjs) and the demo plumbing shared with video/
plugins/
  promptgraph/  # Claude Code plugin: .mcp.json (runs `promptgraph mcp`, packages/server/src/mcp) + skills
.claude-plugin/marketplace.json
docs/
  DESIGN.md
```

## Commands

- Install: `pnpm install`
- Build: `pnpm build` (shared, server, web; never needs Rust)
- Typecheck: `pnpm typecheck`
- Test: `pnpm test` (root vitest; tests use temp repos and a temp `PG_HOME`)
- Dev: `pnpm --filter @promptgraph/server dev` (the daemon in the foreground) + `pnpm --filter @promptgraph/web dev` (vite; its proxy adds no credentials: sign in with `promptgraph open --print-url --web-port <vite port>`)
- Desktop (needs Rust + WebKitGTK): `pnpm --filter @promptgraph/desktop tauri:dev`

## Conventions

- All code, comments, commit messages and documentation in **English**.
- Every shape crossing a boundary (graph files, REST bodies, WS messages, hook payloads) is defined once as a zod schema in `packages/shared` and its type is derived with `z.infer`. Never redefine those types by hand.
- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Keep the engine pure where possible: state transitions (activations, skips, readiness, lane assignment) should be testable without spawning processes. Runners and git operations sit behind interfaces.
- Tests: unit tests for the engine and lane assignment; integration tests for git/worktree operations against temporary repos. Never run tests against the user's real repositories.

## Architectural invariants

Do not break these without updating the design document first:

1. **Never parse the Claude Code TUI.** Node state comes only from CLI flags we pass (`--session-id`, `--settings`, …), hook payloads (`SessionStart`, `PreToolUse`, `Notification`, `Stop`) and the session transcript file.
2. **Hooks never block Claude.** The `pg-hook` script forwards the payload and always exits 0.
3. **The engine is activation-based** (§8.1), not a one-shot topological sort, so conditions and loops (Phase 2) remain extensions.
4. **Nothing leaves the machine without approval.** `pr` nodes require an approval gate by default; no code path pushes without one.
5. **`bypassPermissions` is never a default** and is not exposed in the UI.
6. **The daemon binds to `127.0.0.1` only** and every REST and WS request requires the persistent local token (Bearer) or a server-side session cookie (created through a one-time login code, revocable, Fetch-Metadata checked); hook requests require their node run's hook token. The token lives only in `~/.promptgraph/token` (0600): it is never printed, logged, put in any URL or tool result, sent to a daemon that has not proved it knows it (`/api/daemon/hello`), or made available to Claude PTYs (no `PG_HOME`, `permissions.deny` in `--settings`). GET requests have no side effects.
7. **One daemon per user (`PG_HOME`) manages every registered repository**, each in its own `RepoContext` (graph store, lanes, engine); a repository is identified by its realpath and `repoId`, and is never managed twice (kernel-held daemon lock; the daemon also holds the legacy per-repo locks so pre-M7 binaries refuse to start). A failure in one repository never takes the daemon down. Worktrees live in `~/.promptgraph/worktrees/`, never inside the target repo.
8. Joining parallel lanes always goes through a `merge` node.

## Scope guardrails

Out of scope (do not implement unless the design changes): multi-user or remote hosting, Windows/macOS support (also for the desktop app), reusable flow libraries, a context templating language, export to Claude Code workflows.
