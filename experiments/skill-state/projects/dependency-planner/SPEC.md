# Dependency Planner

Build a dependency-free TypeScript CLI for Bun in `src/cli.ts`.

Input is a JSON file containing:

```json
{ "tasks": [{ "id": "build", "duration": 3, "dependsOn": ["lint"] }] }
```

Run it as `bun run src/cli.ts plan INPUT.json` and print exactly one JSON object.

## Validation

- `tasks` is an array; ids are unique non-empty strings.
- Duration is a finite non-negative number.
- `dependsOn` defaults to `[]`, contains unique strings, references known ids, and cannot contain the task itself.
- Invalid JSON/schema and unknown command/flags fail non-zero with useful stderr.

## Output

Produce:

- `order`: a deterministic topological order. Whenever multiple tasks are ready, choose lexicographically.
- `layers`: arrays of tasks that can run concurrently. Each layer is lexicographically sorted and a task is placed in
  the earliest layer after all dependencies.
- `earliest`: object keyed by id with `{start, finish}` based on unlimited parallelism.
- `totalDuration`: maximum finish time (0 for no tasks).
- `criticalPath`: one dependency chain whose durations sum to `totalDuration`; when equal alternatives exist, choose
  the lexicographically smallest full id sequence.

If a cycle exists, fail non-zero and print a deterministic concrete cycle to stderr, including the repeated start/end
node (for example `a -> b -> a`). Disconnected components and zero-duration tasks must work. Include a concise
`README.md` and run meaningful self-tests before finishing.
