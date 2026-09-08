# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

Create an input file such as `tasks.json`:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] },
    { "id": "test", "duration": 4, "dependsOn": ["lint"] }
  ]
}
```

Run:

```sh
bun run src/cli.ts plan tasks.json
```

The command writes one JSON object containing the lexicographic topological `order`, concurrent `layers`, earliest start and finish times, `totalDuration`, and a deterministically selected `criticalPath`.

Invalid input, unknown commands or flags, and dependency cycles produce a useful error on stderr and a non-zero exit status.
