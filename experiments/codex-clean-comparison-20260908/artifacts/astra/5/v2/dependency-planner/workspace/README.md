# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input contains a `tasks` array. Each task has a unique non-empty string `id`, a
finite non-negative numeric `duration`, and an optional `dependsOn` array of
unique, known task ids. A task cannot depend on itself.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Scheduling assumes unlimited parallelism.
Ready tasks and layers use case-sensitive lexicographic ordering. Critical-path
ties compare complete id sequences; a shorter prefix sorts first. Empty input
produces empty collections and duration 0. For non-empty all-zero input, the
critical path is the lexicographically smallest single task.

Invalid input, unknown commands or flags, and cycles exit non-zero with a useful
stderr message. Cycle messages follow dependency-to-dependent edges and repeat
the starting node. Relative file paths beginning with `-` can use a `./` prefix.
