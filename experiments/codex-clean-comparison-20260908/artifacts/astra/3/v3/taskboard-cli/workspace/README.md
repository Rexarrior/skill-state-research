# Taskboard CLI

A dependency-free TypeScript task manager. Install Bun, then run from the project directory:

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-30
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another path (its parent directory must exist):

```sh
TASKBOARD_FILE=personal.json bun run src/cli.ts list
```

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries are removed. Dates must be real calendar dates in `YYYY-MM-DD` format. List filters combine with AND; overdue includes only open tasks due strictly before the supplied date. Stats uses today's local date.

Each invocation writes exactly one JSON value to stdout: a task for add/done/delete, an array for list, or `{total, open, done, overdue}` for stats. Failures output `null`, report a diagnostic to stderr, and exit non-zero. Repeating `done` preserves the completion timestamp.

Storage uses a versioned JSON document with increasing integer IDs (deleted IDs are never reused). Writes use a sibling temporary file and atomic rename. Invalid databases are rejected without replacement. Run modifying commands sequentially; concurrent writers are not coordinated.
