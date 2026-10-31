# M0 Spike — results (Claude Code 2.1.314, Linux)

Script: `scripts/spike/spike.js` (+ `pg-hook`). It spawns `claude` in a `node-pty` PTY inside a throwaway git repo
with hooks injected via `--settings`, receives hooks over HTTP, chains a second session with `--resume`, and runs a
slash command passed as the initial message.

| # | Assumption | Result | Consequence for the implementation |
|---|---|---|---|
| A1 | `claude "<msg>"` accepts the initial message, incl. slash commands (`claude "/ping"`) | ✅ Confirmed (custom command in `.claude/commands/ping.md` ran) | No PTY typing fallback needed |
| A2 | `--settings` hooks merge with user hooks and inherit env (`PG_*`) | ✅ Confirmed (`PG_PORT`, `PG_TOKEN`, `PG_NODE_RUN_ID` reached `pg-hook`) | As designed |
| A3 | `Stop` gives a usable last message | ✅ Better than expected: the `Stop` payload contains **`last_assistant_message`** | Use `last_assistant_message`; fall back to polling `transcript_path` (JSONL) only if absent |
| A4 | `Notification` signals `waiting_input` | ✅ Payload: `{ message: "Claude needs your permission", notification_type: "permission_prompt" }` | Store `notification_type` as the waiting reason |
| A5 | Trust dialog per new worktree | ❌ Shown for **every new directory**; trusting the parent does **not** cover children; default option is "No, exit" | Before spawning, the server pre-trusts the exact worktree path: atomic read-modify-write of `projects["<path>"].hasTrustDialogAccepted = true` in `$CLAUDE_CONFIG_DIR/.claude.json` (default `~/.claude.json`). Graph setting `autoTrustWorktrees` (default `true`); if disabled the node shows the dialog and sits in `waiting_input` |
| A6 | `--session-id <uuid>` + later `--resume <id>` | ✅ Confirmed (resumed session remembered the previous answer) | As designed |

Other findings:

- `SessionStart` payload includes `model` (e.g. `claude-opus-5-5`) and `source` (`startup` / `resume`).
- `PreToolUse` payload includes `tool_name` and `tool_input` (e.g. `command`, `file_path`) → activity text like `Bash: pnpm test`.
- Transcript assistant lines carry `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`) and `message.model`, but **no cost** → per-node cost is computed from a price table (§18 Q3).
- `claude` must not inherit `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` from a parent Claude session; the runner strips them.
- In hermetic sandboxes (e.g. Claude Code cloud containers) transcripts are not persisted unless the
  `CLAUDE_CODE_REMOTE*`/`*HERMETIC*` session variables are removed from the child env; the runner strips
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_REMOTE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `*HERMETIC*`.
- First interactive run on a fresh config shows the theme onboarding; `hasCompletedOnboarding: true` in the config avoids it
  (the user's real config already has it).
