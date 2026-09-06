# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

For example, `bun run src/cli.ts plan examples/input.json` runs the included sample.

Input has the form:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success the command writes one compact JSON object to stdout containing `order`, concurrent `layers`, `earliest` start/finish times, `totalDuration`, and a deterministic `criticalPath`. Validation, file, command-line, and cycle errors are written to stderr and return a non-zero status.

Run the self-tests with:

```sh
bun test
```
