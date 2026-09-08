# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and emits a deterministic execution plan.

## Usage

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the form:

```json
{"tasks":[{"id":"build","duration":3,"dependsOn":["lint"]},{"id":"lint","duration":1}]}
```

The command writes one JSON object containing the lexicographical topological `order`, concurrent `layers`, each task's `earliest` start and finish, `totalDuration`, and a deterministically selected `criticalPath`. Invalid input and dependency cycles are written to stderr and return a non-zero exit status.

Run the tests with:

```sh
bun test
```

