# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes exactly one JSON object to stdout. It contains a lexicographically deterministic topological `order`, concurrent `layers`, each task's `earliest` start and finish, the `totalDuration`, and a deterministic `criticalPath`. Invalid input and cycles produce a useful error on stderr and a non-zero exit status.

Run the tests with:

```sh
bun test
```
