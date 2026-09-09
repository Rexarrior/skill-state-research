# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

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

`dependsOn` is optional and defaults to `[]`. The command writes one JSON object containing a lexicographically deterministic topological `order`, concurrent `layers`, earliest start/finish times, `totalDuration`, and a deterministic `criticalPath`.

Malformed input, invalid task data, unknown arguments, missing dependencies, and cycles are reported on stderr with a non-zero exit status. Cycle errors include a concrete closed path.

## Tests

```sh
bun test
```
