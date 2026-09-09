# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array. Each task has a unique non-empty string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array of unique task ids.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success, stdout contains one JSON object with the lexicographic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` timings, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles produce a useful stderr message and a non-zero exit status.

## Tests

```sh
bun test
```
