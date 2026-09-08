# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object whose `tasks` property is an array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. The command writes one JSON object containing `order`, concurrent `layers`, earliest start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles are reported to stderr with a non-zero exit status.
