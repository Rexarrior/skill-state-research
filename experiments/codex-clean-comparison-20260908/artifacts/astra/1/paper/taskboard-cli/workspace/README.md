# Taskboard CLI

A dependency-free TypeScript task manager for Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another path (its parent directory must exist). Each write uses a sibling temporary file and atomic rename. Run mutations sequentially; simultaneous writers are not coordinated.

Every invocation prints one JSON value. `add`, `done`, and `delete` return the affected task; `list` returns tasks ordered by ID; `stats` returns `{total, open, done, overdue}`. Errors return `{"error":"message"}`, write a diagnostic to stderr, and exit nonzero. Invalid databases are rejected without replacement.

Titles are trimmed; tags are trimmed, lowercased, deduplicated, and empty tags removed. Dates must be real calendar dates in `YYYY-MM-DD` format. IDs are never reused after deletion. Repeating `done` preserves the completion timestamp. List filters combine with AND; overdue means an open task due strictly before the supplied date. Stats uses today's local date. Timestamps use ISO UTC strings.
