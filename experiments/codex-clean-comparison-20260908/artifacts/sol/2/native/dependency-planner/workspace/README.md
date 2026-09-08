# Dependency Planner

A dependency-free TypeScript command-line planner for Bun. It validates a task graph and emits a deterministic schedule using unlimited parallelism.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input has one `tasks` array. Every task needs a unique non-empty string `id` and a finite, non-negative numeric `duration`; `dependsOn` is an optional array of unique task IDs.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success, stdout contains exactly one JSON object with `order`, concurrent `layers`, per-task `earliest` start and finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles produce a useful message on stderr and a non-zero exit status.

## Tests

```sh
bun test
```
