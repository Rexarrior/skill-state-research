# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

Create an input file such as `tasks.json`:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Run:

```sh
bun run src/cli.ts plan tasks.json
```

The command prints one JSON object containing the lexicographic topological `order`, concurrent `layers`, each task's `earliest` start and finish, `totalDuration`, and a deterministically selected `criticalPath`.

Invalid input, unsupported arguments, and dependency cycles produce a useful error on stderr and a non-zero exit status.
