# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

Run it with:

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be an object with a `tasks` array. Each task has a unique non-empty `id`, a finite non-negative `duration`, and optional `dependsOn` ids. The command prints one JSON object containing topological `order`, concurrent `layers`, earliest timing, `totalDuration`, and a deterministically selected `criticalPath`.

Invalid input, unsupported arguments, and dependency cycles write a useful error to stderr and exit non-zero. Run the self-tests with `bun test`.
