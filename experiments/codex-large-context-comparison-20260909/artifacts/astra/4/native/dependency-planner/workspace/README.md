# Dependency Planner

A dependency-free TypeScript CLI for Bun. No installation step is needed.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique non-empty string
`id`, a finite non-negative numeric `duration`, and an optional `dependsOn`
array (default `[]`) of unique existing task ids. Self-dependencies are invalid.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object with `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. The order always selects the smallest
currently ready id. Layers reflect dependency depth; times assume unlimited
parallelism. All lexicographic comparisons use JavaScript string ordering
(case-sensitive UTF-16). Critical-path ties compare entire id sequences, with
a shorter prefix first. An empty graph has empty collections and duration 0.

Invalid input, unsupported commands or flags, unreadable files, and cycles
exit non-zero with a diagnostic on stderr and no output on stdout. Cycle
diagnostics include a deterministic closed chain, such as `a -> b -> a`.
Timing uses JavaScript numbers; cumulative durations beyond their finite range
are rejected. For filenames beginning with `-`, use a path such as `./-input.json`.
