# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique non-empty
string `id`, a finite non-negative numeric `duration`, and an optional
`dependsOn` array (default `[]`) of unique existing task ids. Self-dependencies
are rejected.

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints exactly one JSON object:

```json
{"order":["lint","build"],"layers":[["lint"],["build"]],"earliest":{"lint":{"start":0,"finish":2},"build":{"start":2,"finish":5}},"totalDuration":5,"criticalPath":["lint","build"]}
```

`order` always selects the lexicographically smallest ready id. `layers`
places each task one layer after its latest dependency, sorting each layer.
`earliest` gives unlimited-parallelism start and finish times; `totalDuration`
is the maximum finish (zero for empty input).

`criticalPath` is the lexicographically smallest dependency chain attaining
the total duration, listed from prerequisite to dependent. Comparison uses
JavaScript string order and compares whole id sequences; a proper prefix
sorts first. Zero-duration prefixes may be included and zero-duration suffixes
may be omitted according to this rule. Empty input has an empty path; non-empty
input has a non-empty path, even when all durations are zero.

Malformed input, unreadable files, unknown commands/flags, cycles, and numeric
overflow produce useful stderr and a non-zero exit status with no stdout.
Cycle diagnostics follow task-to-prerequisite edges and repeat the start node.
Durations use JavaScript floating-point arithmetic.
