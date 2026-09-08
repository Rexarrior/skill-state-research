# Dependency Planner

A dependency-free TypeScript CLI for Bun. No installation step is needed beyond having Bun available.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input example:

```json
{"tasks":[{"id":"build","duration":3,"dependsOn":["lint"]},{"id":"lint","duration":1}]}
```

Output (one JSON object on stdout):

```json
{"order":["lint","build"],"layers":[["lint"],["build"]],"earliest":{"lint":{"start":0,"finish":1},"build":{"start":1,"finish":4}},"totalDuration":4,"criticalPath":["lint","build"]}
```

Tasks require unique non-empty string ids and finite, non-negative numeric durations. `dependsOn` is optional (defaults to `[]`); it must contain unique known ids and cannot reference the task itself. Extra object fields are ignored.

`order` always selects the lexicographically smallest currently ready task. `layers` groups tasks into the earliest dependency layer, sorting each layer. `earliest` gives start and finish times with unlimited parallel workers; `totalDuration` is the latest finish. `criticalPath` is the lexicographically smallest full dependency-chain id sequence whose duration equals the total. Lexicographic comparisons use locale-independent JavaScript string ordering, with shorter prefixes first. Zero-duration tasks can make a chain start or end inside a component. Empty input produces empty arrays, an empty timing object, and duration zero.

Invalid JSON, invalid schemas, unreadable files, unknown commands/flags, and cycles exit non-zero with an explanation on stderr and no stdout. Cycles include a concrete repeated start/end node; traversal visits ids and their dependencies in sorted order, with each arrow meaning “depends on.” Durations use JavaScript number arithmetic; a computed schedule that overflows to infinity is rejected.
