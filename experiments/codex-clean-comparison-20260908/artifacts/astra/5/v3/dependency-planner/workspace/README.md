# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique non-empty string
`id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array
(default `[]`) of unique existing task ids. Self-dependencies are invalid.

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest` (start and
finish per id), `totalDuration`, and `criticalPath`. Ready tasks and layers use
case-sensitive lexicographic string ordering. Layers reflect dependency depth;
timings assume unlimited parallelism. Critical-path ties compare full id
sequences, with a shorter prefix sorting first. A critical path is a non-empty
dependency chain for a non-empty graph; zero-duration endpoints need not be
included. An empty graph produces empty collections and total duration zero.

Invalid input, unsupported commands or flags, unreadable files, cycles, and
numeric schedule overflow print a useful diagnostic to stderr and exit non-zero.
Cycles include a deterministic concrete chain with its start repeated at the end.
