# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array, for example:

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Each task needs a unique non-empty string `id` and a finite non-negative numeric
`duration`. Optional `dependsOn` defaults to `[]`; dependencies must be unique,
known task ids and cannot refer to the task itself.

Success prints exactly one JSON object with `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Scheduling assumes unlimited parallelism.
Layers reflect dependency depth, independently of durations. All lexical ties
use case-sensitive JavaScript string order. Critical-path ties compare complete
id sequences; a sequence sorts before its strict extensions, so unnecessary
zero-duration suffixes may be omitted. An empty input produces empty collections
and total duration 0.

Invalid input, cycles, file errors, unknown commands, and flags print a useful
error to stderr and exit non-zero. Cycle errors include a concrete directed cycle
with its start node repeated. Arithmetic overflow is reported as an error.
