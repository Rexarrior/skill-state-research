# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input example:

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The CLI prints one JSON object containing `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Dependencies must finish before a task
starts; parallelism is unlimited. Layers reflect dependency depth, not time
intervals. Durations use JavaScript numbers; overflowing schedule totals fail.

Ready tasks and layers use case-sensitive lexicographic string ordering. Tied
critical paths use the smallest full id sequence (a shorter identical prefix
wins). A critical path is a nonempty dependency chain for nonempty input;
zero-duration prefixes are eligible, and a chain may end as soon as it reaches
the total duration. Empty input produces empty collections and duration zero.

Ids must be unique nonempty strings, durations finite and non-negative, and
`dependsOn` (default `[]`) must contain unique known ids other than the task
itself. Invalid inputs, unsupported commands/flags, unreadable files, and
cycles exit nonzero with a diagnostic on stderr. Cycles are reported in
lexicographically traversed task-to-dependency direction, repeating the start
node at the end. Filenames beginning with `-` can be passed using `./`.
