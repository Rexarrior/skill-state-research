# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input is a JSON object whose `tasks` array contains unique task IDs, non-negative finite durations, and optional dependency ID arrays:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Successful runs print one compact JSON object containing a lexicographic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` timings, `totalDuration`, and a deterministic `criticalPath`. Invalid input, unsupported arguments, file errors, and dependency cycles produce a useful error on stderr and a non-zero exit status.

## Tests

```sh
bun test
```
