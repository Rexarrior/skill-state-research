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

Successful runs print one compact JSON object containing `order`, concurrent `layers`, earliest start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input, unsupported arguments, and dependency cycles produce a useful message on stderr and exit non-zero.

## Tests

```sh
bun test
```
