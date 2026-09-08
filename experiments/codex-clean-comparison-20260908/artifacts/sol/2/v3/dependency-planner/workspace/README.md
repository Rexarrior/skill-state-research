# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array. Each task has a unique non-empty string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array of unique task IDs.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success, stdout contains one JSON object with `order`, `layers`, `earliest`, `totalDuration`, and `criticalPath`. Invalid input and cycles produce a useful error on stderr and a non-zero exit status.

## Tests

```sh
bun test
```
