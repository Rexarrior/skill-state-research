# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Run from the project directory:

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another file (its parent directory must exist). Mutations write a sibling temporary file and atomically rename it. The versioned database retains its next ID after deletion; IDs are never reused. Concurrent writers are not supported.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags discarded. Dates must be real calendar dates in `YYYY-MM-DD` format. List filters combine with AND and results sort by ID. Overdue tasks are open with a due date strictly before the supplied date, or today's local date for `stats`.

Every invocation emits exactly one JSON value: a task for `add`, `done`, and `delete`; an array for `list`; or `{total, open, done, overdue}` for `stats`. Repeated `done` preserves the original completion timestamp. Errors emit `{error: "..."}`, also report a diagnostic to stderr, and exit nonzero. Invalid databases are rejected without modification.

Run the integration tests with `bun test`.
