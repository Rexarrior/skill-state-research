# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No installation step is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

The database defaults to `.taskboard.json` in your current directory. Set
`TASKBOARD_FILE` to use another path; its parent directory must exist. Writes use
an atomic sibling-file rename. Run commands sequentially: concurrent writers are
not supported.

Every invocation prints one JSON value. `add`, `done`, and `delete` return the
created, completed, or deleted task; `list` returns an array sorted by ID; `stats`
returns `{total, open, done, overdue}`. Failures print `{ "error": "..." }`, send a
diagnostic to stderr, and exit non-zero without overwriting invalid data.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. IDs increase monotonically and are never reused after deletion.
Dates must be valid `YYYY-MM-DD` dates. List filters combine with AND; overdue
selects only open tasks due strictly before the supplied date. Stats uses today's
local date. Completing an already completed task preserves its timestamp.

Run the process-level self-tests with:

```sh
bun test
```
