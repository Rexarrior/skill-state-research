# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the form:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` may be omitted and defaults to an empty array. On success, stdout contains one JSON object with `order`, concurrent `layers`, each task's `earliest` start and finish, `totalDuration`, and a deterministic `criticalPath`. Invalid input, unsupported arguments, and dependency cycles produce a useful error on stderr and a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
