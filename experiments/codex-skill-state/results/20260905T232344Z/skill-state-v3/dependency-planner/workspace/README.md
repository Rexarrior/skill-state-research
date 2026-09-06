# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has this shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object containing `order`, concurrent `layers`, each task's `earliest` start and finish, `totalDuration`, and a deterministic `criticalPath`. Invalid input and cycles are reported to stderr with a non-zero exit status.

## Test

```sh
bun test
```
