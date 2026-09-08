# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`, a
finite non-negative numeric `duration`, and an optional `dependsOn` array of
unique existing task ids (default `[]`). Self-dependencies are invalid.

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success writes exactly one JSON object to stdout, containing `order` (the smallest
ready id at each step), `layers` (earliest dependency layers, sorted by id),
`earliest` (start and finish times with unlimited parallelism), `totalDuration`,
and `criticalPath`. Lexical comparisons use case-sensitive JavaScript string
ordering. Critical-path ties compare complete id sequences; a prefix sorts before
its extension, including zero-duration extensions. A chain may start at a task
whose dependencies all finish at zero. Empty input tasks yield empty collections
and duration zero.

Malformed input, unsupported commands or flags, unreadable files, cycles, and
numeric schedule overflow exit non-zero with a diagnostic on stderr. Cycles show
a concrete directed chain with the first node repeated at the end. No flags or
external packages are needed. For filenames beginning with `-`, use `./filename`.
