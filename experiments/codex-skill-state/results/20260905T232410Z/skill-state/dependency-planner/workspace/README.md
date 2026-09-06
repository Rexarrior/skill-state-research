# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and computes a deterministic execution plan.

## Usage

Create an input file:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

Then run:

```sh
bun run src/cli.ts plan INPUT.json
```

The command prints one JSON object containing the deterministic topological `order`, concurrent `layers`, each task's `earliest` start and finish, the `totalDuration`, and a lexicographically tie-broken `criticalPath`. Invalid input and dependency cycles produce a useful error on stderr and a non-zero exit status.
