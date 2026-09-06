# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

Run it with:

```sh
bun run src/cli.ts plan INPUT.json
```

The input is `{ "tasks": [...] }`; every task has a unique non-empty `id`, finite non-negative `duration`, and optional `dependsOn` list. The command prints one JSON object containing topological `order`, concurrent `layers`, unlimited-parallelism `earliest` times, `totalDuration`, and a deterministic `criticalPath`.

Validation errors and cycles are written to stderr and exit non-zero. Run the built-in checks with:

```sh
bun run src/cli.ts self-test
```
