# Dependency Planner

Dependency-free Bun TypeScript CLI that validates a task graph and creates a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be an object with a `tasks` array. Every task has a unique non-empty `id`, a finite non-negative `duration`, and optional `dependsOn` ids.

The command prints one JSON object containing a lexical topological `order`, concurrent `layers`, unlimited-parallelism `earliest` timings, `totalDuration`, and a deterministic `criticalPath`. Errors, including a concrete cycle, are written to stderr and exit non-zero.

Run the focused checks with:

```sh
bun test
```
