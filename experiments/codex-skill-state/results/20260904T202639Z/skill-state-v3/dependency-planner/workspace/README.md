# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input format:

```json
{ "tasks": [{ "id": "build", "duration": 3, "dependsOn": ["lint"] }] }
```

`dependsOn` is optional. The command writes one JSON object containing `order`, concurrent `layers`, `earliest` start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input, unsupported arguments, and dependency cycles are reported on stderr with a non-zero exit status.

## Tests

```sh
bun test
```
