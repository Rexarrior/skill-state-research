# Dependency Planner

Dependency-free TypeScript CLI for Bun that validates a task dependency graph and calculates a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array. Every task has a unique non-empty `id`, a finite non-negative `duration`, and an optional `dependsOn` array of unique known task ids.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success, stdout contains exactly one JSON object with a deterministic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` timings, `totalDuration`, and a lexicographically tie-broken `criticalPath`. Invalid input and cycles produce a non-zero exit with an error on stderr.
