# Dependency Planner

A dependency-free TypeScript CLI for Bun. No installation step is needed.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object containing a `tasks` array:

```json
{"tasks":[{"id":"lint","duration":2},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object with `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Dependencies finish before their dependents
start; scheduling assumes unlimited parallelism. Layers describe dependency
depth, not time windows. The example takes 5 time units with critical path
`["lint","build"]`.

Ids must be unique, non-empty strings; durations must be finite non-negative
numbers. Dependencies default to an empty array and must be unique known ids
other than the task itself. Invalid input, unreadable files, cycles, unsupported
commands, and flags print a diagnostic to stderr and exit non-zero.

Ready tasks, layers, and ties use case-sensitive lexicographic string ordering
(JavaScript UTF-16 ordering). Critical-path ties compare the entire id sequence;
a shorter prefix sorts first. A critical path is a non-empty dependency chain
with maximum total duration, and can omit zero-duration ancestors or descendants
when that gives a smaller sequence. Empty input has no critical path and takes
zero time. Cycles report a deterministic closed walk along dependency references.
Sums that overflow JavaScript's finite number range are rejected.
