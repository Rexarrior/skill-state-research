# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has a `tasks` array. Each task requires a unique non-empty string `id` and a finite, non-negative `duration`; `dependsOn` is an optional array of unique task IDs.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object containing a lexicographic topological `order`, concurrent `layers`, earliest start and finish times, total duration, and a deterministic critical path. Invalid input and dependency cycles produce an error on stderr and a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
