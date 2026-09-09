# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Run from the project directory:

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use another path (its parent directory must exist):

```sh
TASKBOARD_FILE=./personal.json bun run src/cli.ts add --title "Buy milk"
```

Every invocation emits one JSON value. `add`, `done`, and `delete` return the
created, completed, or deleted task; `list` returns an array ordered by ID;
`stats` returns `{total, open, done, overdue}`. Errors return `{error: "..."}`,
write a diagnostic to stderr, and exit non-zero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format (years
0001–9999). List filters combine with AND; overdue includes only open tasks with
a due date strictly before the supplied date. Stats uses today's local date.
Completing a task again preserves its original completion time. IDs increase and
are never reused after deletion.

The versioned JSON database stores `nextId` and `tasks`. Invalid databases cause
an error without being overwritten. Writes use a temporary sibling file and an
atomic rename. Run mutations sequentially: concurrent writers are not locked.
