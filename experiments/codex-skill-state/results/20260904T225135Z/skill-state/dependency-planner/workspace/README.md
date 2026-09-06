# Dependency Planner

A dependency-free TypeScript command-line planner for [Bun](https://bun.sh/).

## Usage

Create a JSON file containing a `tasks` array:

```json
{
  "tasks": [
    { "id": "lint", "duration": 2 },
    { "id": "build", "duration": 3, "dependsOn": ["lint"] },
    { "id": "docs", "duration": 1 }
  ]
}
```

Run:

```sh
bun run src/cli.ts plan INPUT.json
```

The command prints one compact JSON object with a deterministic topological
`order`, concurrent `layers`, each task's `earliest` start and finish,
`totalDuration`, and a deterministic `criticalPath`.

Task IDs must be unique non-empty strings. Durations must be finite,
non-negative numbers. `dependsOn` is optional; when present, it must contain
unique known task IDs and cannot reference the task itself. Invalid input,
unknown commands, extra arguments, and dependency cycles are reported on
stderr and exit with a non-zero status.
