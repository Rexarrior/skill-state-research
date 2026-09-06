# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and computes a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has a `tasks` array. Every task needs a unique non-empty string `id` and a finite, non-negative numeric `duration`. `dependsOn` is optional and defaults to an empty array.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success the command writes one JSON object containing `order`, concurrent `layers`, `earliest` start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles produce a useful error on stderr and a non-zero exit status.
