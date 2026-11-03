import { GraphSchema } from "@promptgraph/shared";
import { z } from "zod";

/**
 * Authoring reference returned by the graph_reference tool and the promptgraph://graph-reference
 * resource (§19.3). Kept short: the validator gives precise errors, this explains the model.
 */
export const GRAPH_REFERENCE = `# promptgraph graph format (version 1)

A graph is a JSON file in \`<repo>/.promptgraph/graphs/<id>.json\`. Each node is one step; edges say
what runs after what. Independent branches run in parallel, each in its own git worktree ("lane");
parallel lanes are joined only through a \`merge\` node.

\`\`\`json
{
  "id": "add-search",                 // lowercase letters, digits, dashes (also the file name)
  "name": "Add search, test, commit",
  "settings": {                        // all optional
    "baseBranch": "main",              // lanes branch off this
    "maxParallelClaude": 3,
    "workspaceSetup": "pnpm install",  // shell run once in each new worktree
    "defaults": { "permissionMode": "acceptEdits", "model": "sonnet", "completion": { "mode": "auto", "graceSec": 5 } },
    "keepWorktrees": "on-failure"      // never | on-failure | always
  },
  "nodes": [ { "id": "impl", "type": "prompt", "label": "Implement", "config": { "prompt": "…" } } ],
  "edges": [ { "source": "impl", "target": "test" } ]
}
\`\`\`

\`position\` ({x, y}) and edge \`id\` may be omitted: save_graph lays out nodes left to right and names edges.

## Node types and config

| type | config | notes |
|---|---|---|
| prompt | \`prompt\` (required), \`context\`, \`model\`, \`effort\`, \`permissionMode\`, \`allowedTools\`, \`completion\` | Interactive Claude Code session in the lane's worktree. Output = last assistant message |
| command | \`command\` (e.g. "/code-review high"), same options as prompt | Runs a slash command or skill (list_commands shows what exists) |
| shell | \`run\` (required), \`timeoutSec\`, \`env\` | \`sh -c\` in the worktree. Fails on non-zero exit. Output = exit code + last 200 lines |
| commit | \`message\` (used when \`generateMessage\` is false), \`generateMessage\` (default true), \`squashCheckpoints\` (default true) | Commits the lane's changes |
| pr | \`title\`, \`body\` (generated when absent), \`draft\` (default true), \`base\`, \`requireApproval\` (default true) | Pushes the lane branch and opens a PR with gh, after a human approval |
| approval | \`message\`, \`showDiff\` (default true) | Pauses until the user approves or rejects in the UI |
| merge | \`strategy\`: merge \\| squash, \`onConflict\`: claude \\| pause | Joins 2+ lanes. The only node that may have several inputs from parallel lanes |
| condition | \`evaluator\`: {"kind":"exitCode","equals":0} \\| {"kind":"regex","pattern":"…","flags":""} \\| {"kind":"judge","question":"…"} | Routes to its \`true\` / \`false\` output ports. Evaluates its predecessor's output; exitCode needs a shell predecessor |

Claude node options:
- \`context\`: \`fresh\` (default: new session, predecessors' outputs prepended), \`resume\` (continue the
  single predecessor Claude node's session; it must be in the same lane), \`clean\` (prompt only).
- \`permissionMode\`: acceptEdits (default) | auto | manual | dontAsk | plan. bypassPermissions does not exist.
- \`completion\`: {"mode":"auto","graceSec":5} (done when Claude stops, after a grace period) |
  {"mode":"manual"} (the user clicks Done) | {"mode":"marker","token":"<<PG_DONE>>"} (done when the last
  message contains the token; tell Claude in the prompt to print it).
- \`allowedTools\`: e.g. ["Bash(pnpm test:*)"] so unattended runs do not stop at permission prompts.

Every node: \`id\` (unique), \`type\`, \`label\` (shown on the canvas), \`config\`, optional \`onError\`: pause (default) | fail-run.

## Edges

\`{ "source", "target", "sourcePort"?, "when"?, "loop"? }\`
- \`sourcePort\`: \`out\` (default), \`true\`/\`false\` (condition nodes), \`error\` (failure routing).
- \`when\`: success (default) | failure | always. An \`error\` port edge defaults to failure.
  Use \`"when": "always"\` from a shell node into an exitCode condition, so failing tests still reach it.
- \`loop\`: {"maxIterations": 1-100, "onExhausted": "fail" | "continue"} marks a back-edge to an ancestor.
  Removing loop edges must leave a DAG. Loop back to the shell (or the step producing the output), not
  to an exitCode/regex condition.

## Rules the validator enforces

- No cycles except marked loop edges; no self loops; no duplicate edges.
- A node with several inputs from parallel lanes must be a \`merge\` node (merge needs 2+ inputs).
  Mutually exclusive inputs (true/false branches of one condition) may join without a merge.
- \`context: "resume"\` needs exactly one Claude predecessor in the same lane.
- \`pr\` requires approval unless the graph sets \`settings.allowPrWithoutApproval\`; do not set it unless the user asks.
- Warnings (not blocking): no commit before pr/merge, empty labels.

## Patterns

Linear: prompt → shell (tests) → commit → pr
Fan-out: prompt A and prompt B from one root (two lanes) → merge → shell (tests) → commit
Test-fix loop: prompt implement → shell test →(always) condition exitCode=0 —true→ commit; —false→ prompt fix
  (context resume) —loop(max 3)→ shell test
Review loop: prompt implement → command "/code-review" → condition judge "Are there blocking issues?"
  —false→ commit; —true→ prompt "address the review findings" —loop(max 2)→ command "/code-review"
`;

/** JSON Schema of the graph file as accepted on input (defaults optional). */
export function graphJsonSchema(): unknown {
  return z.toJSONSchema(GraphSchema, { io: "input", unrepresentable: "any" });
}
