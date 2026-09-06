# Dependency Planner

A dependency-free Bun TypeScript CLI that validates a task graph and produces a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array. Every task has a unique non-empty `id`, a finite non-negative `duration`, and an optional `dependsOn` array of known, distinct task ids.

The command prints one JSON object with a lexicographic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` times, `totalDuration`, and a lexicographically tie-broken `criticalPath`. Validation errors and cycles are printed to stderr and return a non-zero status.
