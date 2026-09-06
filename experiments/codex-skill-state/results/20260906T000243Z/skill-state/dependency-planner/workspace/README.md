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
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. On success the command writes one JSON object containing `order`, `layers`, `earliest`, `totalDuration`, and `criticalPath`. Ready tasks and concurrent layers are ordered lexicographically; critical-path ties use the lexicographically smallest complete ID sequence.

Invalid input, unsupported arguments, and dependency cycles produce a useful message on stderr and a non-zero exit status. Cycle messages include a concrete closed path such as `a -> b -> a`.
