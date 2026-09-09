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

On success, stdout contains exactly one JSON object with `order`, `layers`, `earliest`, `totalDuration`, and `criticalPath`. Invalid input, unsupported arguments, file errors, and dependency cycles are reported on stderr with a non-zero exit status.

## Tests

```sh
bun test
```
