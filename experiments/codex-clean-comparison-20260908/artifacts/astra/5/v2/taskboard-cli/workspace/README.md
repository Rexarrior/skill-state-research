# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Run from the project directory:

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent,work" --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to choose another path (its parent directory must exist):

```sh
TASKBOARD_FILE=./personal.json bun run src/cli.ts add --title "Buy milk"
```

Each invocation prints exactly one JSON value. `add`, `done`, and `delete` return the affected task; `list` returns an array ordered by ID; `stats` returns `{total, open, done, overdue}`. Errors return `{error: "..."}`, also print a diagnostic to stderr, and exit nonzero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries are removed. Dates must be real dates in `YYYY-MM-DD` format. List filters combine with AND; overdue includes only open tasks due strictly before the given date. Stats uses today's local date. Completing a task again preserves its original completion timestamp.

The versioned JSON document stores tasks and the next integer ID, so deleted IDs are never reused. Writes use a sibling temporary file and atomic rename. Invalid databases are rejected without being replaced. Run modifying commands sequentially; concurrent writers are not serialized.
