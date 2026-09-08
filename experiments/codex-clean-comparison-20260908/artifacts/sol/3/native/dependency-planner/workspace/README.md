# Dependency Planner

A dependency-free TypeScript command-line planner for Bun. It validates a task graph and emits a deterministic schedule as one JSON object.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input has the following shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. The output contains a lexicographically deterministic topological `order`, concurrent `layers`, each task's `earliest` start and finish, the `totalDuration`, and a deterministic `criticalPath`.

Invalid input, unsupported arguments, missing files, and dependency cycles are reported on stderr and exit non-zero.

## Test

```sh
bun test
```
