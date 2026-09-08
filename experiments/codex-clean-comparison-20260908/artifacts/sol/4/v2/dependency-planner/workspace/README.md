# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic schedule.

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the form:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes exactly one JSON object containing `order`, concurrent `layers`, each task's `earliest` start and finish, `totalDuration`, and a deterministic `criticalPath`. Invalid input, unknown arguments, and dependency cycles produce a useful error on stderr and a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
