# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`, a
finite non-negative `duration`, and an optional `dependsOn` array (default `[]`).
Dependencies must be unique, known task ids and cannot reference the task itself.

The CLI prints one JSON object with `order`, `layers`, `earliest` (start and finish
per id), `totalDuration`, and `criticalPath`. Scheduling assumes unlimited
parallelism. Ready tasks and layers use case-sensitive code-unit lexical order.
Critical-path ties compare complete id sequences; a shorter prefix wins. A chain
may start or end at a zero-duration task, and the empty graph has an empty path.

Invalid input, unsupported commands/flags, and cycles exit non-zero with a useful
stderr message. Cycles include a concrete repeated-start path. Accumulated times
must remain finite. Durations use JavaScript number arithmetic.
