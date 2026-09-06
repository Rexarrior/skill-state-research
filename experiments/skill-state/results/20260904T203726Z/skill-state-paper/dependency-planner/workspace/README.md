# Dependency Planner

Dependency-free Bun TypeScript CLI that validates a task dependency graph and produces a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

Input contains a `tasks` array. Every task has a unique non-empty `id`, a finite non-negative `duration`, and optional `dependsOn` task IDs.

The command prints one JSON object containing a lexicographic topological `order`, parallel `layers`, unlimited-parallelism `earliest` timings, `totalDuration`, and a deterministic `criticalPath`. Errors, including cycles, are written to stderr and exit non-zero.
