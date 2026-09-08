# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input is a JSON object with a `tasks` array. Each task has a unique non-empty string `id`, a finite non-negative `duration`, and an optional `dependsOn` array of task ids.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success, stdout contains exactly one JSON object with the lexicographic topological `order`, concurrent `layers`, earliest start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid inputs and dependency cycles produce a useful error on stderr and a non-zero exit status.

## Tests

```sh
bun test
```
