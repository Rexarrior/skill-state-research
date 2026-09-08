# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object whose `tasks` array contains unique task IDs, finite non-negative durations, and optional `dependsOn` arrays:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command prints one JSON object containing a lexicographically deterministic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` times, `totalDuration`, and a deterministic `criticalPath`. Invalid input and cycles are reported on stderr with a non-zero exit status.
