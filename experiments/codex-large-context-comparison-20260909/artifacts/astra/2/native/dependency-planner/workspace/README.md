# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique non-empty
string `id`, a finite non-negative numeric `duration`, and an optional
`dependsOn` array of unique existing task ids (default `[]`). Self-dependencies
are rejected.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The command writes exactly one JSON object with `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Ready tasks are selected lexicographically;
layers are sorted and use dependency depth. Start/finish times assume unlimited
parallelism. All string ordering uses JavaScript's case-sensitive UTF-16 order.

The critical path is the lexicographically smallest full id sequence among
maximum-duration dependency chains. A shorter sequence wins if it is a prefix
of another; zero-duration endpoints may therefore be omitted. For an empty task
list, all arrays and the timing object are empty and total duration is zero.

Invalid input, unsupported commands or flags, unreadable files, and cycles
produce an error on stderr and a non-zero exit status. Cycle errors show a
concrete closed chain, traversed from dependency to dependent; traversal is
deterministic. Durations whose accumulated schedule overflows are rejected.
Use `./` before a filename beginning with `-`.
