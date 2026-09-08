# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Install Bun, then run:

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent,work" --due 2026-09-30
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Data lives in `.taskboard.json` in the current directory. Override it with
`TASKBOARD_FILE=/path/to/tasks.json`; the parent directory must exist. Writes
use a sibling temporary file followed by an atomic rename. IDs increase and
are never reused after deletion. Simultaneous writers are not coordinated.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format.
List filters combine with AND; overdue selects only open tasks due strictly
before the supplied date. Stats uses today's local date for overdue counts.
Completing an already completed task preserves its original completion time.

Each invocation prints one JSON value: the task for add/done/delete, an array
for list, or `{total, open, done, overdue}` for stats. Failures print `null`,
send a diagnostic to stderr, and exit non-zero. Invalid databases are rejected
without being replaced. Unknown flags, duplicate flags, and extra arguments
are errors.

Run the process-level self-tests with `bun test`.
