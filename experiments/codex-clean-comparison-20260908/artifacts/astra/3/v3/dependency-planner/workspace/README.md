# Dependency Planner

A dependency-free TypeScript CLI for Bun. No installation of packages is needed.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`, a
finite non-negative numeric `duration`, and an optional `dependsOn` array of
unique existing task ids (default `[]`). Self-dependencies are rejected.

```json
{"tasks":[{"id":"build","duration":3,"dependsOn":["lint"]},{"id":"lint","duration":1}]}
```

Success prints one JSON object with `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. The example has order `["lint","build"]`,
layers `[["lint"],["build"]]`, total duration `4`, and critical path
`["lint","build"]`. Earliest times assume unlimited parallelism; layers are
based on dependency depth, not elapsed time.

Ready tasks and layers use JavaScript's case-sensitive string ordering.
Critical-path ties compare full id sequences, with shorter prefixes first.
A nonempty all-zero graph returns the lexically smallest one-task chain;
an empty graph returns empty arrays, an empty timing object, and duration zero.
Numbers use JavaScript number arithmetic; accumulated overflow is rejected.

Invalid input, unreadable files, unsupported commands or flags, and cycles exit
nonzero with an error on stderr and no JSON on stdout. Cycle errors include a
concrete repeated-endpoint path, deterministically found by traversing sorted
ids and dependent tasks. A path beginning with `-` can be supplied as `./-file.json`.
