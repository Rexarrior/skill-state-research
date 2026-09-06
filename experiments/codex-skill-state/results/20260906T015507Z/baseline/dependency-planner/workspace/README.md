# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array. Each task has a unique non-empty string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array of unique task ids.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object containing `order`, concurrent `layers`, `earliest` start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and cycles produce a useful error on stderr and a non-zero exit status.

## Test

```sh
bun test
```
