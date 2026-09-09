# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No install step is required.

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Data persists in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use another path (its parent directory must exist). Writes use a sibling
temporary file and atomic rename. Run writers sequentially; simultaneous writers
are not coordinated.

Each invocation prints one JSON value. `add`, `done`, and `delete` return the
created, completed, or deleted task; `list` returns an array sorted by ID; `stats`
returns `{total, open, done, overdue}`. Errors print `null` to stdout, a diagnostic
to stderr, and exit non-zero without replacing the database.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format. List
filters combine with AND; overdue selects only open tasks due strictly before
the supplied date. Stats uses today's local date. Completing a task twice leaves
its original completion timestamp unchanged. IDs increase and are never reused.
The versioned JSON database stores `version`, `nextId`, and `tasks`; malformed
data is rejected.
