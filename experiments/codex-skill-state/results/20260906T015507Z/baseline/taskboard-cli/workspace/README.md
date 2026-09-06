# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or at the path supplied in
`TASKBOARD_FILE`. Database updates use a sibling temporary file and an atomic
rename.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2030-04-30
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2030-05-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates use the exact
`YYYY-MM-DD` format. `--overdue` uses a strict boundary and only includes open
tasks. All filters on `list` are combined with AND.

Every invocation writes exactly one JSON value to stdout. `add`, `done`, and
`delete` return the affected task; `list` returns an ID-sorted array; and
`stats` returns `{total, open, done, overdue}`. On failure, stdout contains
`{"error":"..."}`, a diagnostic is written to stderr, and the process exits
non-zero.

To keep databases separate:

```sh
TASKBOARD_FILE=/tmp/team-tasks.json bun run src/cli.ts list
```

## Tests

```sh
bun test
```

The integration tests invoke the CLI in separate processes and cover
persistence, ID stability, filtering, date validation, idempotency, statistics,
and preservation of malformed databases.
