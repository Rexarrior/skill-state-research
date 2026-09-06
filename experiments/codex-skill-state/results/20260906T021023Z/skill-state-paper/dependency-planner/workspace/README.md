# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and computes a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object whose `tasks` property is an array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to `[]`. The command prints one compact JSON object containing the lexicographic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` timings, `totalDuration`, and a deterministically selected `criticalPath`.

Malformed inputs, unknown commands or flags, and dependency cycles produce a useful error on stderr and exit non-zero.

## Tests

```sh
bun test
```

