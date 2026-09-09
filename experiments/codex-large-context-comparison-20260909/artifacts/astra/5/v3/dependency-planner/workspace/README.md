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

Success prints one JSON object with `order`, `layers`, `earliest` (start and
finish per id), `totalDuration`, and `criticalPath`. Scheduling assumes unlimited
parallelism. Layers describe dependency depth, not elapsed-time intervals.
Ready tasks, layers, and tied full critical-path sequences use case-sensitive
lexicographic string order. A shorter sequence wins when it is a prefix of
another; zero-duration tasks can therefore be omitted from a tied path.
Empty input tasks produce empty collections and total duration zero.

Ids must be unique non-empty strings; durations must be finite non-negative
numbers. `dependsOn` defaults to `[]` and must contain distinct existing ids,
excluding the task itself. Invalid input, unreadable files, cycles, unsupported
commands, and flags produce stderr and a non-zero exit status. Cycles are
reported as a concrete chain of dependency references with a repeated endpoint.
Schedules that overflow JavaScript's finite numeric range are rejected.
