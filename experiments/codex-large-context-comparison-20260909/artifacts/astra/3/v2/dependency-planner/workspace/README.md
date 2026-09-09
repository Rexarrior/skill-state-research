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

The CLI prints one JSON object with `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Times assume unlimited parallelism.
Layers describe dependency depth, not fixed time slots. Ordering and ties use
case-sensitive JavaScript string ordering. Critical-path ties compare complete
id sequences; a shorter prefix wins over a zero-duration extension. A nonempty
zero-duration graph returns the lexicographically first singleton chain.
An empty graph returns empty arrays and an empty timing object, with duration 0.

Ids must be unique nonempty strings; durations must be finite nonnegative
numbers. Omitted `dependsOn` means `[]`; dependencies must be unique known ids
other than the task itself. Times use JavaScript numbers; overflowing schedule
durations are rejected. Invalid input, unreadable files, cycles, and unsupported
commands or flags produce stderr and a nonzero exit status. Cycles show a
repeatable concrete path following dependency-to-dependent edges.
