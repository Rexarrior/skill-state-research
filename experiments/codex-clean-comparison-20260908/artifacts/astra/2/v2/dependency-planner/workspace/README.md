# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array of unique existing task ids (default `[]`). Self-dependencies are invalid.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest` start/finish times, `totalDuration`, and `criticalPath`. Ready tasks and layers use case-sensitive string lexicographic ordering. Layers reflect dependency depth; timings assume unlimited parallelism. Critical-path ties compare full id sequences, with a shorter prefix sorting first. A chain may start or stop at any task, which matters for zero-duration ties. Empty input tasks produce empty collections and duration 0.

Malformed input, unsupported commands/flags, read errors, and cycles report errors to stderr and exit non-zero. Cycles show a concrete, deterministic closed chain along dependency-to-dependent edges. Schedules exceeding JavaScript's finite numeric range are rejected; other durations use ordinary JavaScript number arithmetic. Use `./` before filenames beginning with `-`.
