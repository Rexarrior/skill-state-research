# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array. Each task has a unique non-empty string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array of unique task IDs.

Successful runs print one compact JSON object containing a lexicographic topological `order`, concurrent `layers`, unlimited-parallelism `earliest` times, `totalDuration`, and a deterministically selected `criticalPath`. Invalid input, unsupported arguments, missing dependencies, and cycles produce a useful error on stderr and a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
