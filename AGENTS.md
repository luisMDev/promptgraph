# AGENTS.md

Guidance for coding agents (Claude Code, Codex, etc.) working in this repository.

## Project

`promptgraph` is a local tool started from the terminal (`promptgraph [repo-dir]`) that serves a React UI on `127.0.0.1`. The user draws a graph where each node is a step — a Claude Code prompt, a slash command, a shell command, a commit, a PR, an approval, a merge — and runs it. Independent branches run in parallel, each in its own git worktree. Clicking a node opens the real, interactive Claude Code terminal of that step.

**The source of truth for behaviour and architecture is [`docs/DESIGN.md`](docs/DESIGN.md).** Read the relevant sections before implementing anything. If an implementation needs to diverge from the design, update `docs/DESIGN.md` in the same change and explain why.

## Status

Design phase. No code yet. Next milestone is **M0 — spike** (`docs/DESIGN.md` §16), a throwaway prototype that validates the assumptions in §17. Do not start M1 until those assumptions are confirmed or the design is adjusted.

## Stack

- Node 22, TypeScript (strict), pnpm workspace
- Server: Hono + `ws`, `node-pty`, `better-sqlite3`, `zod`
- Web: React 19, Vite, `@xyflow/react`, `@xterm/xterm`, `zustand`, Tailwind v4, shadcn/ui (Radix primitives via `radix-ui`; vendored in `packages/web/src/components/ui`, app-level wrappers in `components/common/ui.tsx`)

## Layout (planned)

```
packages/
  shared/   # zod schemas, TS types, WebSocket protocol — imported by server and web
  server/   # CLI entry (bin: promptgraph), engine, runners, workspaces, store, HTTP/WS
  web/      # React app; built assets are served by the server
plugins/
  promptgraph/  # Claude Code plugin: .mcp.json (runs `promptgraph mcp`, packages/server/src/mcp) + skills
.claude-plugin/marketplace.json
docs/
  DESIGN.md
```

## Commands

Not defined yet. When the workspace is scaffolded, document here: install, dev, build, test, lint, typecheck.

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
6. **The server binds to `127.0.0.1` only** and every REST, WS and hook request requires the per-start token.
7. **One server instance manages one repository.** Worktrees live in `~/.promptgraph/worktrees/`, never inside the target repo.
8. Joining parallel lanes always goes through a `merge` node.

## Scope guardrails

Out of scope (do not implement unless the design changes): multi-user or remote hosting, Windows/macOS support, reusable flow libraries, a context templating language, export to Claude Code workflows.
