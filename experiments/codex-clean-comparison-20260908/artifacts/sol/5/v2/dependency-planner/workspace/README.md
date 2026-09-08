# Dependency Planner

A dependency-free TypeScript command-line planner for Bun. It validates a task graph and emits a deterministic schedule using unlimited parallelism.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has this shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command writes one JSON object containing `order`, concurrent `layers`, each task's `earliest` start and finish, `totalDuration`, and a deterministically selected `criticalPath`. Invalid input and dependency cycles produce a non-zero exit status with an explanation on stderr.

Run the self-tests with:

```sh
bun test
```

