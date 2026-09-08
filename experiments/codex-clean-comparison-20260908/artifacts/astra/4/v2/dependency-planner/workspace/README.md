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

The CLI prints one JSON object containing `order` (lexicographically selected
ready tasks), `layers` (earliest dependency levels, sorted), `earliest`
(start/finish times by id), `totalDuration`, and `criticalPath`.
Scheduling assumes unlimited parallelism. Layers express dependency levels,
not fixed time intervals. Lexicographic comparisons use case-sensitive JavaScript
string ordering; a shorter sequence precedes its extensions. Critical-path ties
compare full id sequences, including zero-duration tasks. An empty input task
array produces empty collections and duration zero.

Ids must be unique non-empty strings. Durations must be finite non-negative
numbers. `dependsOn` defaults to `[]` and must contain unique known ids other
than the task itself. Invalid inputs, unreadable files, unsupported commands or
flags, and cycles produce stderr and a nonzero exit code. Cycles are reported
as a deterministic chain of dependency references with the first node repeated.
Numeric scheduling uses JavaScript numbers; overflowing schedules are rejected.
For filenames beginning with `-`, use a path such as `./-input.json`.
