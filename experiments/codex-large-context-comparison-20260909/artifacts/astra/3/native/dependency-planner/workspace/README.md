# Dependency Planner

A dependency-free TypeScript CLI for Bun. No installation of packages is needed.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object containing a `tasks` array:

```json
{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}
```

Each task has a unique non-empty string `id`, a finite non-negative numeric
`duration`, and an optional `dependsOn` array (default `[]`). Dependencies must
be unique known ids and cannot reference the task itself.

Success prints one JSON object with `order`, `layers`, `earliest` (start and
finish per id), `totalDuration`, and `criticalPath`. Ready tasks and layers use
case-sensitive lexicographic string order. Layers describe dependency depth;
times assume unlimited parallelism. Equal critical paths are compared by their
full id sequences, with a shorter prefix first. A path may start or end at a
zero-duration task; a nonempty graph returns a nonempty critical path. An empty
graph returns empty arrays/objects and duration 0.

Invalid input, unreadable files, unsupported commands/flags, and cycles produce
an error on stderr and a nonzero exit status. Cycle errors include a concrete
dependency chain with its start repeated at the end. Numeric calculations use
JavaScript numbers; a schedule whose accumulated duration overflows is rejected.
For filenames starting with `-`, use an explicit relative path such as `./-input.json`.
