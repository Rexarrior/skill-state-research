# Dependency Planner

A dependency-free Bun TypeScript CLI that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array. Each task has a unique non-empty `id`, a finite non-negative `duration`, and an optional `dependsOn` array of known task ids:

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The command writes exactly one JSON object to stdout containing deterministic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` times, `totalDuration`, and a lexicographically tie-broken `criticalPath`. Invalid input and dependency cycles fail with an explanation on stderr.
