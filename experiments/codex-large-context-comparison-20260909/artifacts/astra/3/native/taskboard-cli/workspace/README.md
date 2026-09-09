# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent,work" --due 2026-09-10
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag work --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Set `TASKBOARD_FILE` to select a database; the default is `.taskboard.json`
in the current directory. Its parent directory must already exist. The JSON
document contains `nextId` and `tasks`; deleted IDs are never reused. Changes
use a sibling temporary file and an atomic rename. Use one writer at a time;
concurrent updates are not locked.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format.
List filters combine with AND and results are sorted by ID. Overdue tasks are
open tasks due strictly before the supplied date (or today's local date for
`stats`). Repeating `done` preserves the original completion timestamp.

Every invocation emits exactly one JSON value: a task for `add`, `done`, and
`delete`; an array for `list`; or `{total, open, done, overdue}` for `stats`.
Errors emit `null`, explain the error on stderr, and exit nonzero. Invalid
arguments and malformed databases never silently reset stored tasks.

Run the process-level self-tests with `bun test`.
