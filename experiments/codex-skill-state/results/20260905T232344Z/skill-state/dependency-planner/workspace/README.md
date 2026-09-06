# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has a `tasks` array. Every task needs a unique non-empty string `id` and a finite, non-negative numeric `duration`; `dependsOn` is an optional array of unique task IDs.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command prints one compact JSON object containing the lexicographic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` timings, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles are reported on stderr and return a non-zero status.

## Test

```sh
bun test
```
