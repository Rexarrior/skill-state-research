# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the form:

```json
{"tasks":[{"id":"build","duration":3,"dependsOn":["lint"]},{"id":"lint","duration":1}]}
```

`dependsOn` is optional and defaults to an empty array. Successful execution writes exactly one compact JSON object containing `order`, concurrent `layers`, per-task `earliest` start and finish times, `totalDuration`, and a deterministic `criticalPath`.

Malformed input, invalid task data, unknown commands or flags, missing files, and dependency cycles produce a useful message on stderr and a non-zero exit status. Cycle messages include a concrete closed path such as `a -> b -> a`.

## Tests

```sh
bun test
```
