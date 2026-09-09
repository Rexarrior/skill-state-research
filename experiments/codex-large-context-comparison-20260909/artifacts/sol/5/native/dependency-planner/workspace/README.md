# Dependency Planner

A dependency-free TypeScript command-line planner for Bun. It validates a task graph and emits a deterministic schedule, including parallel layers, earliest start/finish times, total duration, and a critical path.

## Usage

```sh
bun run src/cli.ts plan tasks.json
```

Input has this shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional. Durations are non-negative numbers. The command writes exactly one JSON object to standard output on success; invalid input and dependency cycles produce a useful message on standard error and a non-zero exit code.

## Development

```sh
bun test
```
