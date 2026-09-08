# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object containing a `tasks` array. Each task has a unique non-empty
string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn`
array (default `[]`) of unique existing task ids. Self-dependencies are rejected.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest` (start and
finish per id), `totalDuration`, and `criticalPath`. Ready tasks and layers use
case-sensitive lexicographic string ordering. Layers reflect dependency depth;
times assume unlimited parallelism. Critical-path ties use the smallest full id
sequence, with a shorter prefix sorting first. A non-empty graph has a non-empty
critical path, even when all durations are zero. An empty graph has empty arrays,
an empty timing object, and total duration zero.

Invalid input, unsupported commands or flags, unreadable files, cycles, and
numeric overflow exit non-zero with a diagnostic on stderr. Cycles include a
concrete repeated-start chain in dependency-to-dependent direction. Use `./` for
input filenames beginning with a dash. Durations use JavaScript number arithmetic.
