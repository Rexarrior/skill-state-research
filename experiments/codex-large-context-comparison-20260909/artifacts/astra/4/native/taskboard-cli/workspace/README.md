# Taskboard CLI

A dependency-free TypeScript task manager for Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent,work" --due 2026-10-01
bun run src/cli.ts list --status open --tag work --overdue 2026-10-02
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Requires Bun. No installation or dependencies are needed. Run self-tests with
`bun test`.

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to choose another path (its parent directory must exist):

```sh
TASKBOARD_FILE=./personal.json bun run src/cli.ts list
```

Every invocation prints one JSON value. `add`, `done`, and `delete` return the
affected task; `list` returns tasks sorted by ID; `stats` returns
`{total, open, done, overdue}`. Failures return `{"error":"message"}`, also print
a diagnostic to stderr, and exit non-zero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
are ignored. Dates must be real calendar dates in `YYYY-MM-DD` form. List filters
combine with AND; overdue means an open task due strictly before the supplied
date. Stats uses today's local date. Completing a task again preserves its
original completion timestamp. Deleted IDs are never reused.

The versioned JSON database stores tasks and the next ID. Invalid databases are
rejected without being replaced. Changes use a sibling temporary file followed
by an atomic rename. Sequential processes share persisted data; concurrent
writers are not supported.
