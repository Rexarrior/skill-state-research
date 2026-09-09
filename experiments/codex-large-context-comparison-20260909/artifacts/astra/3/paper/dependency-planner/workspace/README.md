# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`,
a finite non-negative numeric `duration`, and an optional `dependsOn` array
(default `[]`) of unique known task ids. Self-dependencies are rejected.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object with `order` (lexicographically chosen topological
order), `layers` (earliest dependency layers, sorted), `earliest` (start and finish
per task), `totalDuration`, and `criticalPath`. Times assume unlimited parallelism.
String comparisons use JavaScript's locale-independent UTF-16 ordering. Critical
path ties compare full id sequences; a prefix precedes its extensions, so a path
may end before zero-duration successors. An empty graph has empty arrays and
an empty `earliest` object, with total duration 0.

Invalid input, unsupported arguments, read failures, and cycles produce stderr
and a nonzero exit code. Cycles include a concrete repeated-endpoint dependency
chain. Schedule arithmetic uses JavaScript numbers; overflowing sums are rejected.
