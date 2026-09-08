# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the following shape (a missing `dependsOn` is treated as an empty array):

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

On success, stdout contains exactly one JSON object with a lexicographic topological `order`, concurrent `layers`, each task's `earliest` start and finish times, the `totalDuration`, and a deterministic `criticalPath`.

Malformed input, invalid task data, unsupported arguments, missing files, and dependency cycles produce a useful error on stderr and exit non-zero. Cycle errors include a concrete closed path such as `a -> b -> a`.
