# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique non-empty
string `id`, a finite non-negative numeric `duration`, and an optional
`dependsOn` array (defaults to `[]`) of unique existing task ids.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest`
(start/finish per task), `totalDuration`, and `criticalPath`. Scheduling assumes
unlimited parallelism. Ready tasks and layers use lexicographic string order
(JavaScript UTF-16 comparison). Critical-path ties use the smallest full id
sequence; a shorter prefix sorts first. A chain may begin or end at any task,
so zero-duration prefixes participate in ties and unnecessary zero-duration
suffixes can be omitted. Empty input produces empty collections and duration 0.

Malformed input, unsupported commands/flags, missing files, and cycles exit
non-zero with stderr diagnostics. Cycles include a concrete repeated-node path.
Use `./` before an input filename beginning with `-`. Schedules whose duration
overflows JavaScript's finite numeric range are rejected.
