# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No install step is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent,work" --due 2026-09-30
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Storage defaults to `.taskboard.json` in the current directory. Set
`TASKBOARD_FILE` to use another path (its parent directory must exist):

```sh
TASKBOARD_FILE=./personal.json bun run src/cli.ts add --title "Buy groceries"
bun test
```

Every invocation prints one JSON value. `add`, `done`, and `delete` return the
created, completed, or deleted task; `list` returns an array sorted by ID;
`stats` returns `{total, open, done, overdue}`. Failures print `{error: "..."}`
to stdout, a diagnostic to stderr, and exit non-zero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format.
List filters combine with AND; overdue selects only open tasks with a due date
strictly before the supplied date. Stats uses today's local calendar date.
Completing a task again preserves its original completion timestamp.
IDs increase and are never reused after deletion.

The versioned JSON database is validated before use. Invalid files are never
silently reset. Updates use a sibling temporary file followed by an atomic
rename. Sequential processes share persisted data; simultaneous writers are
not coordinated, so run modifying commands sequentially.
