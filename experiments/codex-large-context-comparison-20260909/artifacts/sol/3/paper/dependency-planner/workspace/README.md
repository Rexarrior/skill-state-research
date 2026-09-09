# Dependency Planner

A dependency-free TypeScript CLI for Bun that validates a task graph and produces a deterministic parallel schedule.

```sh
bun run src/cli.ts plan INPUT.json
```

Input has the form:

```json
{"tasks":[{"id":"build","duration":3,"dependsOn":["lint"]},{"id":"lint","duration":1}]}
```

`dependsOn` may be omitted and defaults to an empty array. On success the command prints one compact JSON object containing the lexical topological `order`, earliest concurrent `layers`, `earliest` start/finish times, `totalDuration`, and a deterministically tie-broken `criticalPath`. Invalid input, unsupported arguments, and cycles produce a useful message on stderr and a non-zero exit status.

Run the tests with:

```sh
bun test
```
