# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input format:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command prints one JSON object containing the lexicographic topological `order`, concurrent `layers`, `earliest` start and finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles are reported on stderr with a non-zero exit code.
