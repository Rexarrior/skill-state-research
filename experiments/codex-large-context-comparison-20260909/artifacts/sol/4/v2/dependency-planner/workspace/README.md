# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input is a JSON object whose `tasks` array contains unique task IDs, non-negative finite durations, and optional `dependsOn` arrays:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Successful runs print exactly one JSON object containing the lexicographic topological `order`, concurrent `layers`, earliest start/finish times, total duration, and a deterministic critical path. Invalid input and dependency cycles produce a useful error on stderr and a non-zero exit status.

## Tests

```sh
bun test
```
