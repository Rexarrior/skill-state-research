# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun; no install step is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag WORK --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to select another file (its parent directory must exist):

```sh
TASKBOARD_FILE=personal.json bun run src/cli.ts add --title "Buy groceries"
```

Each invocation prints one JSON value: `add`, `done`, and `delete` return the
affected task; `list` returns an array sorted by ID; `stats` returns
`{total, open, done, overdue}`. Failures print `{ "error": "..." }` to stdout,
write diagnostics to stderr, and exit non-zero.

Titles are trimmed and cannot be blank. Tags are trimmed, lowercased, deduplicated,
and empty entries are discarded. Dates must be real calendar dates in
`YYYY-MM-DD` format (years 0001–9999). List filters combine with AND; overdue
selects only open tasks due strictly before the given date. Stats uses today's
local date. Completing a task twice preserves its original completion timestamp.

The JSON database contains `version: 1`, a persistent `nextId` counter, and a
`tasks` array. Deleted IDs are never reused. Reads validate the database; invalid
data is never silently reset. Writes use a sibling temporary file followed by
an atomic rename. Run modifying commands sequentially: concurrent writers are
not coordinated.
