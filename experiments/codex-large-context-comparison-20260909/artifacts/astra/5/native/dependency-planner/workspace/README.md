# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique, non-empty
string `id`, a finite non-negative numeric `duration`, and optional `dependsOn`
(an array of unique existing task ids, defaulting to `[]`). Self-dependencies
are invalid.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The command prints exactly one JSON object containing `order`, `layers`,
`earliest` (start and finish per task), `totalDuration`, and `criticalPath`.
Ready tasks and layers use lexicographic, case-sensitive JavaScript string
ordering. Layers describe dependency depth; times assume unlimited parallelism.
Critical-path ties compare entire id sequences, with shorter prefixes first.
A chain may start or end anywhere, including omitting zero-duration tasks.
An empty task list produces empty collections and a total duration of zero.

Invalid input, unreadable files, unsupported commands or flags, and cycles
produce a useful stderr message and a non-zero exit status, with no stdout.
Cycle errors include a deterministic concrete closed dependency chain.
Durations use JavaScript number arithmetic; an overflowing finish time is rejected.
