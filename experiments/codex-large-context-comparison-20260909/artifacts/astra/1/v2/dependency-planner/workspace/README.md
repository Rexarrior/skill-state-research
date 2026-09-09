# Dependency Planner

A dependency-free TypeScript CLI for Bun. No installation of packages is needed.

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

Ids must be unique non-empty strings. Durations must be finite non-negative numbers. Dependencies default to `[]`; they must be unique strings naming other existing tasks.

The order always selects the lexicographically smallest ready task. Layers use dependency depth; times assume unlimited parallel execution. The critical path is the lexicographically smallest full dependency chain with maximum duration. A shorter prefix wins a tie, so zero-duration tasks can be omitted at the end (or included at the start if lexicographically preferable). An empty task list yields empty collections and duration zero. String ordering uses case-sensitive JavaScript code-unit comparison, independent of locale.

Invalid input, unreadable files, unknown commands/flags, cycles, and arithmetic overflow produce stderr and a nonzero exit code, with no JSON output. Cycles are reported as concrete prerequisite-to-dependent chains with the starting node repeated. Relative filenames beginning with `-` can be written as `./-name.json`.
