# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object whose `tasks` array contains unique task IDs, non-negative finite durations, and optional `dependsOn` arrays:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Successful runs print one JSON object containing the lexicographic topological `order`, concurrent `layers`, earliest start/finish times, `totalDuration`, and a deterministically selected `criticalPath`. Invalid input, unsupported arguments, and dependency cycles produce a useful error on stderr and a non-zero exit status.
