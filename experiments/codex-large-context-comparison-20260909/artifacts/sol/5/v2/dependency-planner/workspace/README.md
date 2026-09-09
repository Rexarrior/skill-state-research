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

`dependsOn` is optional. The command writes one JSON object containing the lexicographic topological `order`, concurrent `layers`, earliest start/finish times, total duration, and a deterministically selected critical path. Invalid input and dependency cycles produce a useful error on stderr and a non-zero exit code.

## Tests

```sh
bun test
```
