# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work,urgent,work" --due 2026-12-01
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag work --overdue 2026-12-02
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Data is saved in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use a different file (its parent directory must exist):

```sh
TASKBOARD_FILE=personal.json bun run src/cli.ts add --title "Buy groceries"
```

Every invocation prints exactly one JSON value. `add`, `done`, and `delete`
return the affected task; `list` returns an array sorted by ID; `stats` returns
`{total, open, done, overdue}`. Errors return `{error: "..."}`, print a diagnostic
to stderr, and exit non-zero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format.
Filters combine with AND; overdue selects only open tasks due strictly before
the supplied date. Stats uses today's local date. Repeating `done` preserves
its original completion timestamp. Deleted IDs are never reused.

Storage uses a versioned JSON document containing `version`, `nextId`, and
`tasks`. Invalid data is rejected without replacement. Updates write a sibling
temporary file and rename it atomically. Concurrent writers are not supported;
run modifying commands sequentially.
