# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. The command prints one compact JSON object containing the lexicographic topological `order`, concurrent `layers`, earliest start and finish times, the total duration, and a deterministic critical path.

Malformed input, invalid task definitions, unknown arguments, and dependency cycles are reported on stderr and return a non-zero exit status.
