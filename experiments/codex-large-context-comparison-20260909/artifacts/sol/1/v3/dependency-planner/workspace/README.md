# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the following shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional. The command prints one JSON object containing the lexical topological `order`, concurrent `layers`, earliest start/finish times, `totalDuration`, and a deterministically selected `criticalPath`. Invalid input and dependency cycles are reported on stderr with a non-zero exit status.

## Tests

```sh
bun test
```
