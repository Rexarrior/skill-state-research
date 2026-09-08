# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Run from the project directory:

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-10
bun run src/cli.ts list --status open --tag work --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use another path (its parent directory must exist). Writes use a sibling
temporary file and atomic rename. Use one writer at a time; concurrent updates
are not locked.

Each invocation emits exactly one JSON value. `add`, `done`, and `delete` return
the affected task; `list` returns tasks sorted by ID; `stats` returns counts.
Failures emit an `{ "error": "..." }` object, a diagnostic on stderr, and a
nonzero exit code. Invalid storage is rejected without overwriting it.

Titles are trimmed; tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. IDs increase monotonically and are never reused after deletion.
Dates must be real calendar dates in `YYYY-MM-DD` format. List filters combine
with AND; overdue selects only open tasks due strictly before the specified
date. Stats uses today's local date. Repeated `done` preserves `completedAt`.

Run subprocess persistence and validation tests with `bun test`.
