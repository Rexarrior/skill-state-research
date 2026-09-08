# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No install step is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags "work, urgent,Work" --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Data is stored in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use another path (relative paths resolve from the current directory):

```sh
TASKBOARD_FILE=./data/tasks.json bun run src/cli.ts list
```

Each invocation prints exactly one JSON value. `add`, `done`, and `delete` return
the affected task; `list` returns an array ordered by ID; `stats` returns
`{total, open, done, overdue}`. Errors print `null` to stdout, a diagnostic to
stderr, and exit non-zero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated in input order,
and empty entries are discarded. Dates must be real calendar dates in
`YYYY-MM-DD` form. List filters combine with AND; overdue selects only open
tasks due strictly before the supplied date. Stats uses today's local date.
Completing a task again preserves its original completion timestamp.

The database contains `{nextId, tasks}`; IDs are never reused after deletion.
Invalid JSON or an invalid database schema causes an error without overwriting
the file. Writes use a unique sibling temporary file and an atomic rename.
Run modifying commands sequentially: simultaneous writers are not coordinated.
