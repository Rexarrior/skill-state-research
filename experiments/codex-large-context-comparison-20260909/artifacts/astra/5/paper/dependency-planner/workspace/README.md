# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input: `{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}`.

The CLI prints one JSON object containing `order`, `layers`, `earliest`
(start/finish per id), `totalDuration`, and `criticalPath`. Dependencies default
to an empty array. Durations must be finite and non-negative. Ids must be unique,
non-empty strings; dependencies must be unique known ids other than the task itself.

Ready tasks and layers use case-sensitive JavaScript lexicographic string order.
Layers place every task immediately after its deepest dependency. Scheduling
assumes unlimited parallelism. Critical-path ties compare complete id sequences;
a shorter prefix wins. Chains may start or end at any task, including zero-duration
tasks. Empty input produces empty collections and duration 0.

Invalid input, cycles, unsupported commands/flags, unreadable files, and numeric
sum overflow exit non-zero with a diagnostic on stderr. Cycle diagnostics follow
`dependsOn` links and repeat the starting node. No flags are supported; use `./`
for an input filename beginning with `-`.
