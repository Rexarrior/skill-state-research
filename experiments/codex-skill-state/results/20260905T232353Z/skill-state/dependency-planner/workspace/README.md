# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has this shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object containing `order`, concurrent `layers`, earliest start and finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input, unsupported arguments, and dependency cycles produce a useful error on stderr and a non-zero exit status.
