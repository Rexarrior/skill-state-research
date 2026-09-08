# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input file must contain a `tasks` array. Every task has a unique, non-empty string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array of unique task ids:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] },
    { "id": "test", "duration": 2, "dependsOn": ["lint"] }
  ]
}
```

The command writes one compact JSON object to standard output. It includes the lexicographically deterministic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` start and finish times, `totalDuration`, and a deterministic `criticalPath`.

Invalid input, unknown arguments, unreadable files, and dependency cycles produce a useful message on standard error and a non-zero exit status. A cycle message includes a concrete closed path such as `a -> b -> a`.
