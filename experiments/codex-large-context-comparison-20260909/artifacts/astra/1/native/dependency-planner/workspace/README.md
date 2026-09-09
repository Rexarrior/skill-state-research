# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique non-empty
string `id`, a finite non-negative numeric `duration`, and an optional
`dependsOn` array of unique existing task ids (default `[]`). Self-dependencies
are invalid.

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object with `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. The example yields order and critical
path `["lint","build"]`, layers `[["lint"],["build"]]`, and total duration 5.
Times assume unlimited parallelism. Layers use dependency depth, including
zero-duration tasks. Ordering uses case-sensitive JavaScript string comparison
(UTF-16 code units), independent of locale. Critical-path ties compare full id
sequences, with a shorter prefix first; chains may start or end at any task.
An empty graph has no layers or critical path and total duration 0.

Invalid input, unsupported commands/flags, file errors, cycles, and schedule
duration overflow produce an error on stderr and a non-zero exit status with
no JSON on stdout. Cycles include a concrete repeated start/end node; detection
visits ids and dependency edges in lexical order.
