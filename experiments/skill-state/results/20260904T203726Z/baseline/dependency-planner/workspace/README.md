# Dependency Planner

Dependency-free TypeScript CLI for Bun that validates task dependencies and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The command writes one JSON object to stdout. Input must contain a `tasks` array; each task has a unique non-empty `id`, a finite non-negative `duration`, and an optional `dependsOn` array.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Run the self-tests with:

```sh
bun test
```
