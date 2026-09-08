# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

Input has a `tasks` array. Every task needs a unique non-empty `id` and a finite, non-negative `duration`; `dependsOn` is an optional array of task IDs.

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The single JSON value written to stdout contains a lexicographically deterministic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` times, `totalDuration`, and a deterministically tie-broken `criticalPath`. Invalid input and cycles produce a useful error on stderr and a non-zero exit status.

Run the test suite with:

```sh
bun test
```
