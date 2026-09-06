# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic schedule.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input format:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

The command prints one compact JSON object containing `order`, concurrent `layers`, each task's `earliest` start and finish, `totalDuration`, and a deterministic `criticalPath`. Invalid input and dependency cycles produce a useful error on stderr and a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
