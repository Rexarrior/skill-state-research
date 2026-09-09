# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and computes a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must contain a `tasks` array. Each task has a unique non-empty `id`, a finite non-negative `duration`, and an optional `dependsOn` array of task IDs:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Successful runs write one JSON object to stdout containing `order`, concurrent `layers`, `earliest` start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input, invalid arguments, and dependency cycles produce a useful error on stderr and a non-zero exit status.

## Tests

```sh
bun test
```
