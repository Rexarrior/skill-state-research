# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates task graphs and produces a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

`INPUT.json` contains `{ "tasks": [...] }`. Every task has a unique non-empty `id`, a finite non-negative `duration`, and optional `dependsOn` string ids. The command prints one JSON object with topological `order`, concurrent `layers`, unlimited-parallelism `earliest` timings, `totalDuration`, and a deterministic `criticalPath`.

Invalid input, unsupported arguments, and cycles fail with a non-zero exit code and an explanation on stderr.
