# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-30
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to choose another path (its parent directory must exist). Writes use a sibling
temporary file followed by an atomic rename. Run modifying commands sequentially;
concurrent writers are not coordinated.

Each invocation prints one JSON value. `add`, `done`, and `delete` return the
created, completed, or deleted task; `list` returns an array ordered by ID;
`stats` returns `{total, open, done, overdue}`. Errors return `{error: "..."}`,
write a diagnostic to stderr, and exit non-zero without replacing stored data.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
are omitted. IDs increase and are never reused after deletion. Dates must be real
calendar dates in `YYYY-MM-DD` format. List filters combine with AND; overdue
means an open task due strictly before the given date. Stats uses today's local
date. Completing an already completed task preserves its original timestamp.
The versioned JSON database is validated before use; malformed data is rejected.

Run the process-level self-tests with:

```sh
bun test
```
