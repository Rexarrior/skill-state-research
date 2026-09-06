# Dependency Planner

Dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be JSON with a `tasks` array. Each task has a unique non-empty string `id`, a finite non-negative numeric `duration`, and optional `dependsOn` string ids.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

The command writes exactly one JSON object to stdout on success: topological `order`, concurrent `layers`, unlimited-parallelism `earliest` times, `totalDuration`, and a deterministic `criticalPath`. Invalid input or cycles write an explanation to stderr and exit non-zero.

Run the included checks with:

```sh
bun test test/self-test.ts
```
