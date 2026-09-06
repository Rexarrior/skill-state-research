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

The single JSON object written to stdout contains the lexicographic topological `order`, concurrent `layers`, earliest start and finish times, `totalDuration`, and a deterministic `criticalPath`. Validation, file, command, and cycle errors are written to stderr and return a non-zero exit status.

## Tests

```sh
bun test
```
