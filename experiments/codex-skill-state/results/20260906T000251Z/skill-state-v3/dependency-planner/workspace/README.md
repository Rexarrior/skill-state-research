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
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. The command writes one JSON object containing `order`, concurrent `layers`, per-task `earliest` start/finish times, `totalDuration`, and a deterministic `criticalPath`.

Invalid input, unsupported arguments, and dependency cycles are reported on stderr and exit with a non-zero status.
