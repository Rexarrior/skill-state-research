# Dependency Planner

A dependency-free TypeScript CLI requiring Bun. No installation step is needed.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`, a
finite non-negative numeric `duration`, and an optional `dependsOn` array of
unique known task ids (default `[]`). Self-dependencies are invalid.

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints exactly one JSON object with `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Order always chooses the smallest currently
ready id. Layers use dependency depth; timing assumes unlimited parallelism.
Ties in the critical path use the smallest full id sequence, with a shorter
prefix sorting first. Lexicographic comparisons use JavaScript string ordering
(case-sensitive UTF-16 code units), independent of input order or locale.
An empty task list returns empty collections and duration zero.

Invalid input, unknown commands/flags, unreadable files, cycles, and computed
numeric overflow exit non-zero with a diagnostic on stderr. Cycles include a
concrete repeated start/end node in dependency-reference direction.
