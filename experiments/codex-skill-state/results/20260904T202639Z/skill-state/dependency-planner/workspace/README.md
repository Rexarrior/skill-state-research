# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input is a JSON object with a `tasks` array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to `[]`. IDs must be unique non-empty strings, durations must be finite non-negative numbers, and dependencies must be unique known task IDs other than the task itself.

Successful runs print one compact JSON object containing:

- `order`: lexicographically deterministic topological order
- `layers`: earliest concurrent execution layers
- `earliest`: start and finish times with unlimited parallelism
- `totalDuration`: maximum finish time
- `criticalPath`: lexicographically smallest full task sequence when critical paths tie

Invalid input, unsupported arguments, and dependency cycles write a useful error to stderr and exit non-zero. Cycle errors include a concrete closed path such as `a -> b -> a`.
