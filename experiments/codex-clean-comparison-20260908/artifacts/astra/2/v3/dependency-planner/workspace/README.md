# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input example:

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The CLI prints one JSON object with `order`, `layers`, `earliest` (start and
finish by task id), `totalDuration`, and `criticalPath`. Scheduling assumes
unlimited parallelism. Layers describe dependency depth, not time windows.
Ready tasks and layers use lexicographic string order (case-sensitive UTF-16).
Critical-path ties compare complete id sequences, with shorter prefixes first.
A critical chain may start or end at any task, including around zero-duration
tasks; an empty graph has an empty path and duration zero.

Ids must be unique non-empty strings, durations finite and non-negative, and
optional `dependsOn` arrays must contain unique known ids other than the task
itself. Invalid input, unsupported commands/flags, file errors, and cycles
produce stderr and a nonzero exit status. Cycles include a deterministic concrete
chain with a repeated endpoint. Accumulated durations must fit a finite JavaScript
number; times otherwise use ordinary JavaScript number arithmetic.
