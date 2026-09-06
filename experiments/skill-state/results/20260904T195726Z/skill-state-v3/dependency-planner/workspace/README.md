# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the form:

```json
{"tasks":[{"id":"build","duration":3,"dependsOn":["lint"]},{"id":"lint","duration":1}]}
```

The command writes one JSON object containing `order`, concurrent `layers`, earliest start/finish times, `totalDuration`, and a deterministic `criticalPath`. Invalid input, unsupported arguments, and dependency cycles produce an error on stderr and a non-zero exit status.

Run the tests with:

```sh
bun test
```
