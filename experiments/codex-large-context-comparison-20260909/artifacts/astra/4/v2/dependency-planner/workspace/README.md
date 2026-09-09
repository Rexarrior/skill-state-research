# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique non-empty string
`id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array
(default `[]`) of unique known task ids. Self-dependencies are invalid.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest` (start and
finish per task), `totalDuration`, and `criticalPath`. Scheduling assumes unlimited
parallelism. Layers use dependency depth, independent of duration. Ready tasks and
layers are sorted by JavaScript string lexicographic order, without locale rules.
Critical-path ties compare complete id sequences; a sequence sorts before its
extensions. Chains may start or end at any task, which matters for zero durations.
An empty graph has empty arrays and timing object, and total duration zero.

Invalid input, file errors, unsupported commands/flags, and dependency cycles
produce stderr and a nonzero exit status. Cycles include a deterministic concrete
chain with the start node repeated; arrows follow dependency references.
Durations use JavaScript numbers; accumulated overflow is rejected.
