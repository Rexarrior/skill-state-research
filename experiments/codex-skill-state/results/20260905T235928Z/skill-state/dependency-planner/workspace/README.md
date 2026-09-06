# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input format:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one compact JSON object containing `order`, `layers`, `earliest`, `totalDuration`, and `criticalPath`. Invalid input and dependency cycles are reported on stderr with a non-zero exit status.

## Tests

```sh
bun test
```

