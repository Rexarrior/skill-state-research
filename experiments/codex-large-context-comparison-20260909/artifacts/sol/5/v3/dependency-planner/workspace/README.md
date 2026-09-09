# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces
a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. The command prints one JSON
object containing the lexicographic topological `order`, concurrent `layers`, each
task's `earliest` start and finish, the `totalDuration`, and a deterministic
`criticalPath`.

Invalid input, unsupported arguments, file errors, and dependency cycles are
reported on stderr and exit with a non-zero status.
