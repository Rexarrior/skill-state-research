# Dependency Planner

A dependency-free TypeScript command-line planner for Bun. It validates a task graph and emits a deterministic schedule using unlimited parallelism.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

The input must be a JSON object with a `tasks` array. Every task has a unique non-empty string `id`, a finite non-negative numeric `duration`, and an optional `dependsOn` array of unique task IDs.

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

On success, stdout contains one JSON object with `order`, `layers`, `earliest`, `totalDuration`, and `criticalPath`. Invalid input, unsupported arguments, file errors, and dependency cycles produce a useful error on stderr and a non-zero exit status.

## Test

```sh
bun test
```
