# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-10-01
bun run src/cli.ts list --status open --tag work --overdue 2026-10-02
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use another file (its parent directory must exist). Writes use a sibling temporary
file and atomic rename. Run commands sequentially; concurrent writers are not supported.

Each invocation prints exactly one JSON value. `add`, `done`, and `delete` return the
affected task; `list` returns tasks sorted by ID; `stats` returns counts. Errors print
`null`, describe the problem on stderr, and exit non-zero. Invalid databases are never
silently reset.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries are
removed. Dates must be real calendar dates in `YYYY-MM-DD` format. List filters
combine with AND; overdue selects only open tasks due strictly before the supplied
date. Stats uses today's local date. Completing a task twice preserves its original
completion timestamp. IDs increase and are never reused after deletion.
