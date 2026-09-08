# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input example:

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Output is exactly one JSON object:

```json
{"order":["lint","build"],"layers":[["lint"],["build"]],"earliest":{"lint":{"start":0,"finish":2},"build":{"start":2,"finish":5}},"totalDuration":5,"criticalPath":["lint","build"]}
```

Tasks require unique non-empty string ids and finite non-negative numeric durations.
Optional `dependsOn` defaults to `[]` and must list unique, known ids other than
the task itself. Extra object fields are ignored. No command-line flags are supported.

`order` always selects the lexicographically smallest ready id. `layers` group
tasks by dependency depth, each sorted lexicographically. `earliest` gives start
and finish times with unlimited parallelism. `totalDuration` is the makespan.
`criticalPath` is the lexicographically smallest full dependency-chain sequence
with that duration; zero-duration prefixes are allowed, and a shorter sequence
wins when it is a prefix of another. An empty input produces empty collections,
duration 0, and an empty path. String ordering uses JavaScript's case-sensitive
UTF-16 ordering, independent of locale.

Errors go to stderr with a non-zero exit status and no stdout. Cycles include a
deterministic concrete chain, with each arrow pointing to a dependency and the
first node repeated at the end. Timing uses JavaScript numbers; sums that
overflow the finite number range are reported as errors.
