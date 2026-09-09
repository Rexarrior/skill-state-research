# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`, a
finite non-negative numeric `duration`, and an optional `dependsOn` array of
unique existing task ids (defaults to `[]`). Self dependencies are invalid.

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Scheduling assumes unlimited parallelism.
Ready tasks and layers use lexicographic string order (case-sensitive JavaScript
string comparison). Critical-path ties compare full id sequences; a shorter
prefix wins. A nonempty all-zero graph has a one-task critical path with the
smallest id. Empty input produces empty collections and duration zero.

Invalid input, unreadable files, unknown commands/flags, and cycles produce a
nonzero exit code with a diagnostic on stderr. Cycles include a concrete repeated
start/end node, following dependency links. Numeric schedule overflow is rejected.
