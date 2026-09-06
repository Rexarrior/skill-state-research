# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input must contain a `tasks` array. Every task has a unique non-empty string `id`, a finite non-negative `duration`, and an optional `dependsOn` array of unique known task IDs.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Successful runs print one compact JSON object containing the lexicographic topological `order`, concurrent `layers`, earliest start/finish times, `totalDuration`, and the lexicographically smallest critical path. Invalid input and cycles produce a useful error on stderr and a non-zero exit status.

## Tests

```sh
bun test
```
