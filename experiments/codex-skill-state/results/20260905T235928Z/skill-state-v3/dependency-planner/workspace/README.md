# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must contain a `tasks` array. Each task has a unique non-empty string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array of task IDs.

Successful runs print one JSON object containing a lexicographical topological `order`, concurrent `layers`, unlimited-parallelism `earliest` times, `totalDuration`, and a deterministic `criticalPath`. Errors, including a concrete cycle when present, are written to stderr and return a non-zero status.

## Tests

```sh
bun test
```
