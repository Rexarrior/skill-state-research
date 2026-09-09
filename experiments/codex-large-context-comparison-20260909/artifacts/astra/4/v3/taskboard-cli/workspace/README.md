# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun; no installation of packages is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work,release,work" --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Data persists in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another path (its parent directory must exist):

```sh
TASKBOARD_FILE=personal.json bun run src/cli.ts list
```

Titles are trimmed; tags are trimmed, lowercased, deduplicated, and empty entries removed. Dates must be real calendar dates in `YYYY-MM-DD` form. IDs increase and are never reused after deletion. Repeating `done` preserves the original completion time.

Each invocation emits exactly one JSON value: a task for `add`, `done`, and `delete` (the deleted task); an array sorted by ID for `list`; or `{total, open, done, overdue}` for `stats`. Failures emit `null`, describe the error on stderr, and exit nonzero. Unknown or duplicate flags, malformed databases, and missing tasks are errors.

List filters combine with AND. Overdue tasks must be open and have a due date strictly before the supplied date, or today's local date for `stats`.

The versioned JSON database stores `version`, `nextId`, and `tasks`. Writes use a sibling temporary file followed by atomic rename. Run modifying commands sequentially; concurrent writers are not coordinated.
