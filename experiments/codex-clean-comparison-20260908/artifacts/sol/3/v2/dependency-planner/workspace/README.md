# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

Create an input file:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Run:

```sh
bun run src/cli.ts plan INPUT.json
```

The command writes one JSON object containing the lexicographic topological `order`, concurrent `layers`, each task's `earliest` start and finish, the `totalDuration`, and a deterministically selected `criticalPath`. Invalid input and dependency cycles produce a useful error on stderr and a non-zero exit status.
