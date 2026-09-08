# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-20
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Data lives in `.taskboard.json` in the working directory. Set `TASKBOARD_FILE`
to use another file (its parent directory must exist):

```sh
TASKBOARD_FILE=personal.json bun run src/cli.ts list
```

Each invocation prints one JSON value. `add`, `done`, and `delete` return the
affected task; `list` returns an array ordered by ID; `stats` returns counts.
Failures return `{"error":"..."}`, write a diagnostic to stderr, and exit nonzero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format.
List filters combine with AND; overdue includes only open tasks due strictly
before the given date. Stats uses today's local date for overdue counts.
Completing an already completed task preserves its original completion time.
Deleted IDs are never reused.

The versioned JSON database stores `version`, `nextId`, and `tasks`. Invalid
databases are rejected without replacement. Updates use a sibling temporary
file and atomic rename. Run writers sequentially; concurrent writers are not
coordinated.
