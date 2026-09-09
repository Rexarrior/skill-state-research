# Dependency Planner

A dependency-free TypeScript command-line planner for [Bun](https://bun.sh/). It validates a JSON task graph and prints a deterministic schedule as one JSON object.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input format:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. The output contains a lexicographic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` start and finish times, `totalDuration`, and a deterministic `criticalPath`.

Invalid input and dependency cycles produce a useful error on stderr and a non-zero exit status.
