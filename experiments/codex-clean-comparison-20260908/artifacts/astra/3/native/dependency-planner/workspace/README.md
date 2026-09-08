# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique non-empty string
`id`, a finite non-negative numeric `duration`, and an optional `dependsOn`
array (default `[]`). Dependencies must be unique known ids and cannot include
the task itself.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The CLI prints one JSON object containing `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. The example produces:

```json
{"order":["lint","build"],"layers":[["lint"],["build"]],"earliest":{"lint":{"start":0,"finish":1},"build":{"start":1,"finish":4}},"totalDuration":4,"criticalPath":["lint","build"]}
```

Ready tasks use lexicographic JavaScript string ordering. Layers reflect
dependency depth; times assume unlimited parallelism. Critical-path ties use
the smallest full id sequence, with a shorter prefix sorting first. A chain
may omit zero-duration predecessors or successors. Empty input yields empty
collections and a duration of zero. Durations use JavaScript number arithmetic;
schedule overflow is reported as an error.

Invalid input, unreadable files, unsupported commands or flags, and cycles
produce stderr and a nonzero exit status, without JSON on stdout. Cycle
diagnostics follow dependency references and repeat the starting node.
