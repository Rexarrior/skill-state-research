# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input example:

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The CLI prints one JSON object containing `order`, concurrent `layers`,
`earliest` start/finish times by id, `totalDuration`, and `criticalPath`.
Ready tasks and layers use lexicographic id order (case-sensitive JavaScript
string order). Layers reflect dependency depth; times assume unlimited
parallelism. Critical-path ties compare complete id sequences, with a shorter
prefix sorting first. A nonempty all-zero schedule selects the smallest id;
an empty schedule has empty arrays and duration 0.

Ids must be unique nonempty strings. Durations must be finite nonnegative
numbers. `dependsOn` defaults to `[]` and must contain distinct known ids,
excluding the task itself. Invalid input, unsupported arguments, unreadable
files, cycles, and numeric schedule overflow exit nonzero with an error on
stderr. Cycle errors show a deterministic closed chain of dependency references.
Times use JavaScript number arithmetic.
