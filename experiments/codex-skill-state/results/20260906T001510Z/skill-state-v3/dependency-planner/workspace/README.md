# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input format:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success, stdout contains one JSON object with the lexicographic topological `order`, concurrent `layers`, `earliest` start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles produce a useful message on stderr and a non-zero exit code.

## Tests

```sh
bun test
```
