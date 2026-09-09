# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the following shape; `dependsOn` is optional and defaults to an empty array.

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one compact JSON object containing `order`, `layers`, `earliest`, `totalDuration`, and `criticalPath`. Invalid input, unsupported arguments, file errors, and dependency cycles are written to stderr and return a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
