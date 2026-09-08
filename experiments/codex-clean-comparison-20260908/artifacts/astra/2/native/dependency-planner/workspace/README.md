# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input example:

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Success prints one JSON object containing `order`, `layers`, `earliest`,
`totalDuration`, and `criticalPath`. Times assume unlimited parallelism; layers
reflect dependency depth, not elapsed time. Durations use JavaScript numbers;
schedule arithmetic must remain finite.

IDs are unique non-empty strings. Durations are finite non-negative numbers.
`dependsOn` defaults to `[]`; dependencies must be unique known IDs other than
the task itself. Empty and disconnected graphs are supported.

Ready tasks, layers, and tied critical paths use case-sensitive JavaScript
lexicographic ordering (UTF-16 code units). Critical paths are dependency chains
with maximum total duration; ties compare complete ID sequences, with a shorter
prefix first. Zero-duration endpoints may be omitted when that gives a smaller
sequence. An empty graph has an empty critical path and duration zero.

Invalid input, unknown commands or flags, unreadable files, and cycles exit
non-zero with an explanation on stderr and no JSON on stdout. Cycle reports
follow dependency links, with sorted DFS traversal and a repeated start/end ID.
