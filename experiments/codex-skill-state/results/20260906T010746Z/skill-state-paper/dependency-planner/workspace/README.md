# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the form:

```json
{"tasks":[{"id":"build","duration":3,"dependsOn":["lint"]},{"id":"lint","duration":1}]}
```

The single JSON object written to stdout contains a lexicographical topological `order`, concurrent `layers`, earliest start/finish times, the total duration, and a deterministic critical path. Invalid input, unsupported arguments, and dependency cycles are reported on stderr with a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
