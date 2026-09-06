# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the following shape; `dependsOn` is optional and defaults to an empty array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success, stdout contains one JSON object with the lexical topological `order`, concurrent `layers`, earliest start/finish times, `totalDuration`, and a deterministically selected `criticalPath`. Invalid input and dependency cycles produce a useful error on stderr and a non-zero exit code.

## Test

```sh
bun test
```
