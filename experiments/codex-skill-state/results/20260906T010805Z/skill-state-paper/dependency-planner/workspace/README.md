# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has this shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object containing a lexicographic topological `order`, concurrent `layers`, each task's `earliest` start and finish, the `totalDuration`, and a deterministic `criticalPath`. Independent tasks run in parallel. Invalid input, unknown arguments, and cycles produce a useful error on stderr and a non-zero exit status.

Task ids must be unique non-empty strings. Durations must be finite non-negative numbers. `dependsOn` is optional, but when present must contain unique task ids that exist and must not include the task itself.
