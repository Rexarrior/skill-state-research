# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`, a
finite non-negative numeric `duration`, and optional `dependsOn` (default `[]`).
Dependencies must be unique known task ids and cannot reference the task itself.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success writes one JSON object with `order`, `layers`, `earliest`, `totalDuration`,
and `criticalPath`. Ready tasks and layers use lexicographic, case-sensitive
JavaScript string ordering. Layers represent dependency depth; timings assume
unlimited parallelism. Critical-path ties use the smallest full id sequence,
with a shorter prefix sorting first (including when durations are zero). An empty
graph has duration 0 and an empty critical path. Durations use JavaScript numbers;
schedule overflow is reported as an error.

Invalid input, unsupported commands/flags, unreadable files, and cycles exit
non-zero with a diagnostic on stderr. Cycles include a concrete closed chain,
following task-to-dependency edges, chosen deterministically by sorted DFS.
