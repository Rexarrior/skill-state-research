# Dependency Planner

A dependency-free TypeScript command-line planner for [Bun](https://bun.sh/).

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object containing a `tasks` array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. Task IDs must be unique,
non-empty strings. Durations must be finite non-negative numbers, and dependencies
must be unique known task IDs other than the task itself.

On success, the command writes exactly one JSON object to standard output. It
contains a deterministic topological `order`, concurrent `layers`, each task's
`earliest` start and finish, the `totalDuration`, and a deterministic
`criticalPath`.

Invalid input, unsupported arguments, file errors, and dependency cycles produce
a useful message on standard error and a non-zero exit status. Cycle messages
include a concrete closed path such as `a -> b -> a`.
