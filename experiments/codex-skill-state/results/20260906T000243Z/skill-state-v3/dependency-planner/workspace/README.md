# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input is a JSON object whose `tasks` array contains unique task IDs, non-negative durations, and optional dependency lists:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success the command prints one JSON object containing `order`, concurrent `layers`, `earliest` start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid inputs and dependency cycles produce a useful error on stderr and a non-zero exit code.

## Tests

```sh
bun test
```

