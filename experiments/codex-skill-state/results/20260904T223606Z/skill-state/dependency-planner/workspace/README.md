# Dependency Planner

Dependency-free TypeScript CLI for Bun that validates a task dependency graph and produces a deterministic execution plan.

## Run

```sh
bun run src/cli.ts plan INPUT.json
```

The command writes exactly one JSON object to stdout. Errors, including invalid input and cycles, are written to stderr and return a non-zero status.

Input shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Output contains a lexicographic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` times, `totalDuration`, and a deterministically selected `criticalPath`.

## Test

```sh
bun test src/cli.test.ts
```
