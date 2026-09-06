# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the form:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object containing `order`, concurrent `layers`, `earliest` start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles are explained on stderr and return a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
