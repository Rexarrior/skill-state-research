# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the form:

```json
{"tasks":[{"id":"build","duration":3,"dependsOn":["lint"]},{"id":"lint","duration":1}]}
```

The single JSON result contains a lexicographic topological `order`, concurrent `layers`, earliest start/finish times, the total duration, and a deterministic critical path. Invalid input and dependency cycles are written to stderr and return a non-zero exit status.

Run the tests with `bun test`.
