# Graph patterns

Complete graphs you can pass to `save_graph` and adapt. Positions and edge ids are left out on
purpose: `save_graph` fills them in.

## Plan, implement, test, commit (linear)

```json
{
  "id": "add-verbose-flag",
  "name": "Plan, implement, test, commit",
  "settings": { "baseBranch": "main", "maxParallelClaude": 1 },
  "nodes": [
    { "id": "plan", "type": "prompt", "label": "Plan",
      "config": { "prompt": "Read the codebase and write a short implementation plan for: add a --verbose flag to the CLI. Do not edit files yet.",
                  "permissionMode": "plan", "completion": { "mode": "manual" } } },
    { "id": "implement", "type": "prompt", "label": "Implement",
      "config": { "prompt": "Implement the plan above. Keep the change small and add tests.", "context": "resume" } },
    { "id": "tests", "type": "shell", "label": "Run tests", "config": { "run": "npm test", "timeoutSec": 600 } },
    { "id": "commit", "type": "commit", "label": "Commit", "config": {} }
  ],
  "edges": [
    { "source": "plan", "target": "implement" },
    { "source": "implement", "target": "tests" },
    { "source": "tests", "target": "commit" }
  ]
}
```

## Fan out, merge, review, PR (parallel lanes)

```json
{
  "id": "health-endpoint",
  "name": "Spec, backend + docs in parallel, merge, PR",
  "settings": { "baseBranch": "main", "maxParallelClaude": 2, "workspaceSetup": "pnpm install" },
  "nodes": [
    { "id": "spec", "type": "prompt", "label": "Write the spec",
      "config": { "prompt": "Write docs/spec.md describing a /health endpoint: route, response body, status codes and tests." } },
    { "id": "backend", "type": "prompt", "label": "Backend",
      "config": { "prompt": "Implement the /health endpoint described in docs/spec.md, with unit tests. Do not edit the README." } },
    { "id": "docs", "type": "prompt", "label": "Docs",
      "config": { "prompt": "Document the /health endpoint from docs/spec.md in the README. Do not edit source files." } },
    { "id": "merge", "type": "merge", "label": "Merge lanes", "config": { "onConflict": "claude" } },
    { "id": "tests", "type": "shell", "label": "Tests", "config": { "run": "pnpm test" } },
    { "id": "commit", "type": "commit", "label": "Commit", "config": {} },
    { "id": "pr", "type": "pr", "label": "Open PR", "config": { "draft": true } }
  ],
  "edges": [
    { "source": "spec", "target": "backend" },
    { "source": "spec", "target": "docs" },
    { "source": "backend", "target": "merge" },
    { "source": "docs", "target": "merge" },
    { "source": "merge", "target": "tests" },
    { "source": "tests", "target": "commit" },
    { "source": "commit", "target": "pr" }
  ]
}
```

## Test-fix loop

```json
{
  "id": "implement-until-green",
  "name": "Implement, then test and fix until green",
  "settings": { "baseBranch": "main" },
  "nodes": [
    { "id": "implement", "type": "prompt", "label": "Implement",
      "config": { "prompt": "Implement the feature described in TODO.md, with tests.",
                  "allowedTools": ["Bash(npm test:*)"] } },
    { "id": "tests", "type": "shell", "label": "Run tests", "config": { "run": "npm test", "timeoutSec": 600 } },
    { "id": "green", "type": "condition", "label": "Tests green?",
      "config": { "evaluator": { "kind": "exitCode", "equals": 0 } } },
    { "id": "fix", "type": "prompt", "label": "Fix failing tests",
      "config": { "prompt": "The tests above fail. Fix the code (not the tests) so they pass.", "context": "resume" } },
    { "id": "commit", "type": "commit", "label": "Commit", "config": {} }
  ],
  "edges": [
    { "source": "implement", "target": "tests" },
    { "source": "tests", "target": "green", "when": "always" },
    { "source": "green", "sourcePort": "true", "target": "commit" },
    { "source": "green", "sourcePort": "false", "target": "fix" },
    { "source": "fix", "target": "tests", "loop": { "maxIterations": 3, "onExhausted": "fail" } }
  ]
}
```

## Review loop with a human gate

```json
{
  "id": "review-until-clean",
  "name": "Review until no blocking issues",
  "settings": { "baseBranch": "main" },
  "nodes": [
    { "id": "implement", "type": "prompt", "label": "Implement",
      "config": { "prompt": "Implement the feature described in TODO.md, with tests." } },
    { "id": "review", "type": "command", "label": "Code review", "config": { "command": "/code-review" } },
    { "id": "blocking", "type": "condition", "label": "Blocking issues?",
      "config": { "evaluator": { "kind": "judge", "question": "Did the review report any blocking issue?", "model": "haiku" } } },
    { "id": "address", "type": "prompt", "label": "Address findings",
      "config": { "prompt": "Address the blocking findings of the review above." } },
    { "id": "approve", "type": "approval", "label": "Looks good?",
      "config": { "message": "Check the diff before committing." } },
    { "id": "commit", "type": "commit", "label": "Commit", "config": {} }
  ],
  "edges": [
    { "source": "implement", "target": "review" },
    { "source": "review", "target": "blocking" },
    { "source": "blocking", "sourcePort": "true", "target": "address" },
    { "source": "blocking", "sourcePort": "false", "target": "approve" },
    { "source": "approve", "target": "commit" },
    { "source": "address", "target": "review", "loop": { "maxIterations": 3, "onExhausted": "fail" } }
  ]
}
```

## Failure routing

Send a failing build to a fix step instead of pausing the run:

```json
{ "source": "build", "sourcePort": "error", "target": "fix-build" }
```
