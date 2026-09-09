# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and computes a deterministic execution plan.

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

`dependsOn` is optional and defaults to an empty array. Successful runs print one JSON object containing the lexical topological `order`, concurrent `layers`, each task's `earliest` start and finish, `totalDuration`, and a deterministically selected `criticalPath`.

Invalid input, unsupported arguments, file errors, and dependency cycles are written to stderr and return a non-zero exit status. Cycles include a concrete path such as `a -> b -> a`.

## Tests

```sh
bun test
```
