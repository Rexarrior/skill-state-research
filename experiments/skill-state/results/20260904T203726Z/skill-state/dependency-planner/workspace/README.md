# Dependency Planner

Dependency-free Bun TypeScript CLI that validates a task dependency graph and produces a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

Input is JSON with a `tasks` array. Each task has a unique non-empty `id`, a finite non-negative `duration`, and optional `dependsOn` array:

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The command writes exactly one JSON result to stdout. Invalid input, invalid arguments, and cycles fail non-zero with an explanation on stderr.
