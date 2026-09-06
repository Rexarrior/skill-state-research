# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Successful execution prints one JSON object containing `order`, concurrent `layers`, per-task `earliest` start and finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles produce a useful error on stderr and a non-zero exit status.

## Tests

```sh
bun test
```
