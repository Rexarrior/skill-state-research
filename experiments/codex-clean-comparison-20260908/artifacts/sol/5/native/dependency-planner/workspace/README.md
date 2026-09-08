# Dependency Planner

A dependency-free TypeScript command-line planner for Bun. It validates a task graph and reports a deterministic topological order, parallel execution layers, earliest timings, total duration, and a critical path.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has this shape:

```json
{
  "tasks": [
    { "id": "lint", "duration": 1 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] }
  ]
}
```

`dependsOn` is optional and defaults to an empty array. Successful runs print one compact JSON object to stdout. Invalid input, unsupported arguments, unreadable files, and dependency cycles print an explanation to stderr and exit non-zero.

## Development

Run the self-tests with:

```sh
bun test
```
