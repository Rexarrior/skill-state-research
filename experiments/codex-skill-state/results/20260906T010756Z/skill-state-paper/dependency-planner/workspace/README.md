# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input must be a JSON object with a `tasks` array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. IDs must be unique non-empty strings, durations must be finite non-negative numbers, and every dependency must be unique, known, and different from its task.

The command prints one compact JSON object containing:

- `order`: lexicographically deterministic topological order
- `layers`: earliest dependency-safe concurrency layers
- `earliest`: start and finish times with unlimited parallelism
- `totalDuration`: maximum finish time
- `criticalPath`: lexicographically tie-broken dependency chain determining the total duration

Invalid input, unsupported arguments, and cycles produce a useful error on stderr and a non-zero exit code. Cycle errors include a concrete closed path such as `a -> b -> a`.
