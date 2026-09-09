# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the following shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. The command writes one compact JSON object containing a deterministic topological `order`, concurrency `layers`, earliest start and finish times, the `totalDuration`, and a lexicographically tie-broken `criticalPath`. Invalid input and cyclic graphs produce a useful error on stderr and a non-zero exit status.

## Tests

```sh
bun test
```
