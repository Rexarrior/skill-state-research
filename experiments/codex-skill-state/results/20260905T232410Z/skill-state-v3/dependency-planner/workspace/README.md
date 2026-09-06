# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and computes a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object containing `order`, `layers`, `earliest`, `totalDuration`, and `criticalPath`. Ready tasks and concurrent layers are ordered lexicographically. Validation errors and deterministic cycle details are written to stderr and return a non-zero exit code.
