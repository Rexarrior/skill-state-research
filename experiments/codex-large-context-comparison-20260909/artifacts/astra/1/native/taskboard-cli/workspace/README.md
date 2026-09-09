# Taskboard CLI

A dependency-free TypeScript task manager for Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work,urgent,work" --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Storage defaults to `.taskboard.json` in the current directory. Override it with
`TASKBOARD_FILE=/path/to/tasks.json`; the parent directory must exist. Writes use
a sibling temporary file and atomic rename. Use one writer at a time.

Each invocation prints exactly one JSON value. `add`, `done`, and `delete` return
the affected task; `list` returns an array ordered by ID; `stats` returns
`{total, open, done, overdue}`. Errors return `{"error":"message"}`, write a
diagnostic to stderr, and exit non-zero. Invalid databases are never reset.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
discarded. Dates must be real calendar dates in `YYYY-MM-DD` format (years
0001–9999). List filters combine with AND. Overdue tasks are open with due dates
strictly before the supplied date, or today's local date for `stats`.
Completion is idempotent, preserving the original `completedAt`. IDs are never
reused after deletion. A missing database starts empty.

Run the process-level self-tests with `bun test`.
