# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,release,work --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-20
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to choose another path (its parent directory must exist). Each change writes a
sibling temporary file and atomically renames it. Run one writer at a time;
concurrent modifications are not coordinated.

IDs are positive integers and never reused after deletion. Titles are trimmed;
tags are trimmed, lowercased, deduplicated, and empty tags discarded. Due dates
must be real dates in `YYYY-MM-DD` form. List filters combine with AND and results
are sorted by ID. Overdue means an open task due strictly before the supplied
date; stats uses today's local date. Repeating `done` preserves `completedAt`.

Every invocation emits one JSON value: a task for add/done/delete, an array for
list, or `{total, open, done, overdue}` for stats. Errors emit `{error: "..."}`,
write a diagnostic to stderr, and exit nonzero. Invalid input or malformed data
is never silently replaced. The database contains `version`, `nextId`, and `tasks`.

Run the process-level self-tests with `bun test`.
