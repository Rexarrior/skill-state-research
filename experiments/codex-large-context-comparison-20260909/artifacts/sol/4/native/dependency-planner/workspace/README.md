# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input file must contain a `tasks` array. Every task has a unique non-empty string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array of unique task IDs:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object containing the lexicographically deterministic topological `order`, concurrent `layers`, each task's `earliest` start and finish, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles are explained on stderr and return a non-zero exit status.

## Tests

```sh
bun test
```
