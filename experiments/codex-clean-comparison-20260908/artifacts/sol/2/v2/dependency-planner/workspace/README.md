# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic schedule.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Run `bun run src/cli.ts --help` for a usage reminder.

Input has the following shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional. The command writes one JSON object containing `order`, concurrent `layers`, earliest start and finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles are reported on stderr with a non-zero exit status.

## Tests

```sh
bun test
```
