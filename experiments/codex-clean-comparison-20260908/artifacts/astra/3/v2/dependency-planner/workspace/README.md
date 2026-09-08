# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input example:

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The CLI prints one JSON object containing `order`, `layers`, `earliest`
(`start` and `finish` per task), `totalDuration`, and `criticalPath`.
Durations use whatever consistent time unit the input supplies. Dependencies
finish before their dependents start; parallelism is unlimited.

Ready tasks and layers use case-sensitive JavaScript string ordering.
Critical-path ties compare full id sequences lexicographically; a shorter
prefix wins. A chain may omit zero-duration endpoints. Empty input produces
empty collections and duration zero.

Task ids must be unique non-empty strings, durations finite and non-negative,
and dependencies unique known ids excluding the task itself. Omitted
`dependsOn` means `[]`. Invalid input, unsupported commands or flags, unreadable
files, cycles, and arithmetic overflow fail with stderr and a nonzero exit.
Cycle errors include a concrete directed cycle with its start repeated.
