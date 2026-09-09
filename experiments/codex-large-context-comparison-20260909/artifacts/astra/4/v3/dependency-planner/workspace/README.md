# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object with a `tasks` array. Each task has a unique non-empty string
`id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array
(default `[]`) of unique known task ids. Self dependencies are invalid.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. The order always picks the smallest ready id;
layers place each task immediately after its deepest dependency layer. Earliest
start/finish times assume unlimited parallelism. The critical path is the
lexicographically smallest maximum-duration dependency chain. A shorter sequence
sorts before its extensions, including zero-duration extensions. Empty input tasks
produce empty collections and duration 0. String ordering uses JavaScript's
locale-independent UTF-16 ordering; durations use JavaScript numbers.

Malformed input, unknown commands/flags, unreadable files, duration overflow, and
cycles exit non-zero with an explanation on stderr and no result on stdout.
Cycle errors show a concrete repeated-node chain in dependency-to-dependent order;
sorted traversal makes the reported cycle independent of input order.
