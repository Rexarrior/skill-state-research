# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`, a
finite non-negative numeric `duration`, and an optional `dependsOn` array of
unique existing task ids (default `[]`). Self-dependencies are invalid.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The command prints one JSON object containing `order`, `layers`, `earliest`
(start and finish by id), `totalDuration`, and `criticalPath`. Ready tasks and
layers use lexicographic ordering (case-sensitive JavaScript string order).
Layers reflect dependency depth; times assume unlimited parallelism. Equal
critical chains use the lexicographically smallest full id sequence, with a
shorter prefix winning. Zero-duration prefixes may be included and unnecessary
zero-duration suffixes are omitted. Empty input returns empty collections and
zero duration.

Invalid input, unsupported commands/flags, unreadable files, and cycles produce
stderr and a non-zero exit code. Cycles include a concrete repeated-endpoint
chain following dependency references. Schedules exceeding the finite numeric
range are rejected. Durations use JavaScript number arithmetic.
