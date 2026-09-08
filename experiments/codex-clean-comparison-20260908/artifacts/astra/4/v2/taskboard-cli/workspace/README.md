# Taskboard CLI

A dependency-free TypeScript task manager for Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,Release,work --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-20
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Set `TASKBOARD_FILE` to choose a database path; the default is `.taskboard.json`
in the current directory. The parent directory must exist. Writes use a sibling
temporary file and atomic rename. Run writers sequentially; concurrent writers
are not coordinated.

Each invocation prints one JSON value. `add` and `done` return the task; `delete`
returns the removed task; `list` returns an array sorted by ID; `stats` returns
`{total, open, done, overdue}`. Errors print `{error: "..."}` to stdout, a diagnostic
to stderr, and exit non-zero without replacing the database.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format. List
filters combine with AND; overdue means an open task due strictly before the
supplied date. Stats uses today's local date. Completion is idempotent and keeps
its original timestamp. IDs increase across deletions and are never reused.

The JSON database contains `version: 1`, `nextId`, and `tasks`. Malformed JSON or
invalid database fields are rejected. Missing databases start empty.
