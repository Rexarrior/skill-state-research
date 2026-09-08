# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique, non-empty
string `id`, a finite non-negative numeric `duration`, and an optional
`dependsOn` array of unique existing task ids (default `[]`). Self-dependencies
are invalid.

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Ready tasks and layers use lexicographic
order (case-sensitive JavaScript string ordering). Layers describe dependency
depth; start/finish times assume unlimited parallelism. Critical path ties use
the smallest full id sequence, with shorter prefixes first. A chain can start
or end at any task, so unnecessary zero-duration endpoints may be omitted.
Empty input produces empty collections and duration zero.

Invalid input, file errors, unsupported commands/flags, cycles, and numeric
schedule overflow print an error to stderr and exit non-zero. Cycles include
a concrete repeated-endpoint path following `dependsOn` edges, selected by
lexicographic depth-first traversal. For a filename starting with `-`, use a
relative path such as `./-input.json`.
