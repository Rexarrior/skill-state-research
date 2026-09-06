# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

For example, `bun run src/cli.ts plan examples/input.json`.

Input has the following shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object to stdout containing `order`, `layers`, `earliest`, `totalDuration`, and
`criticalPath`. Invalid input, unsupported arguments, and dependency cycles produce a diagnostic on stderr and a
non-zero exit code.

## Tests

```sh
bun test
```
