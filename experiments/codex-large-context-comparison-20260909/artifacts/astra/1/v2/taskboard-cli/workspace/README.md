# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set
`TASKBOARD_FILE` to use another path (its parent directory must exist):

```sh
TASKBOARD_FILE=team.json bun run src/cli.ts list
```

Each invocation prints exactly one JSON value. `add`, `done`, and `delete`
return the affected task; `list` returns an array sorted by ID; `stats` returns
`{total, open, done, overdue}`. Failures print `null`, explain the error on
stderr, and exit non-zero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. Dates must be real calendar dates formatted `YYYY-MM-DD`.
List filters combine with AND; overdue selects only open tasks with a due date
strictly before the supplied date. Stats uses today's local date. Completing
an already completed task preserves its original completion timestamp.

The versioned JSON database keeps a monotonically increasing ID counter so
IDs are never reused after deletion. Invalid databases are rejected without
being overwritten. Changes use a sibling temporary file followed by an atomic
rename. Run writers sequentially: concurrent updates are not coordinated.
