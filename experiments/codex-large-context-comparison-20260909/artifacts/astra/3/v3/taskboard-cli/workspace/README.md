# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Run from this directory:

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use another path (its parent directory must exist):

```sh
TASKBOARD_FILE=./personal.json bun run src/cli.ts list
bun test
```

Each invocation prints one JSON value. `add`, `done`, and `delete` return the
created, completed, or deleted task; `list` returns an array; `stats` returns
`{total, open, done, overdue}`. Failures return `{error: "..."}`, also report the
error on stderr, and exit nonzero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are dropped. Dates must be real calendar dates in `YYYY-MM-DD` format. List
filters combine with AND; overdue selects only open tasks due strictly before
the supplied date. Stats uses today's local date. Completing a task twice
preserves its original completion timestamp.

The versioned JSON database preserves increasing IDs even after deletion.
Malformed data is rejected without replacement. Updates use a sibling temporary
file and atomic rename. Run mutations sequentially: concurrent writers are not
locked and may overwrite each other's changes.
