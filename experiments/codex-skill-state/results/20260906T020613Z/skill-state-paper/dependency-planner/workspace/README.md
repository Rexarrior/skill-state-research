# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input is a JSON object with a `tasks` array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Each task requires a unique, non-empty string `id` and a finite, non-negative numeric `duration`. `dependsOn` is an optional array of unique task ids and defaults to `[]`.

On success, stdout contains exactly one JSON object with `order`, `layers`, `earliest`, `totalDuration`, and `criticalPath`. Ready tasks and concurrent layers are ordered lexicographically. On invalid input, an unknown argument, or a dependency cycle, the program writes a useful error to stderr and exits non-zero.
