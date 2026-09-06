# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the following shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success, stdout contains one JSON object with the lexical topological `order`, concurrent `layers`, earliest start/finish times, total duration, and a deterministic critical path. Invalid input, unsupported arguments, and dependency cycles produce a useful error on stderr and a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
