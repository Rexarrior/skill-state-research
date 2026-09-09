# Dependency Planner

A dependency-free TypeScript CLI requiring Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input example:

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Successful execution prints one JSON object with `order`, `layers`, `earliest`
(start/finish times by id), `totalDuration`, and `criticalPath`.
Layers use dependency depth; times assume unlimited parallelism. Ordering uses
case-sensitive JavaScript string comparison, independent of locale. Critical-path
ties compare complete id sequences; a shorter prefix wins, so trailing
zero-duration tasks may be omitted. An empty project has duration 0 and empty paths.

Task ids must be unique non-empty strings, durations finite non-negative numbers,
and dependencies unique known ids other than the task itself. Omitted `dependsOn`
defaults to `[]`. Invalid input, unsupported commands/flags, file errors, and
cycles report an error to stderr and exit non-zero. Cycles include a deterministic
concrete dependency chain with its start repeated at the end.
