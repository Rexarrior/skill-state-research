# Dependency Planner

A dependency-free TypeScript command-line planner for [Bun](https://bun.sh/). It validates a JSON task graph and emits a deterministic execution plan as one JSON object.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

An input file has this shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. The output contains a lexicographically deterministic topological `order`, concurrent `layers`, each task's `earliest` start and finish times, `totalDuration`, and a deterministic `criticalPath`.

Invalid input, unsupported arguments, unreadable files, and dependency cycles produce a useful error on stderr and a non-zero exit status.
