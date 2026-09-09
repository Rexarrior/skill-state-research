# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun; no installation of packages is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent,work" --due 2026-10-01
bun run src/cli.ts list --status open --tag work --overdue 2026-10-02
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Override it with
`TASKBOARD_FILE=/path/to/tasks.json`; its parent directory must exist. Writes use a
sibling temporary file followed by an atomic rename. Run one writer at a time;
concurrent modifications are not locked.

Each invocation prints one JSON value. `add`, `done`, and `delete` return the
created, completed, or deleted task. `list` returns tasks sorted by ID; `stats`
returns `{total, open, done, overdue}`. Errors return `{error: "message"}` on
stdout, a diagnostic on stderr, and a nonzero exit code. Invalid databases are
rejected without replacement.

Titles are trimmed; tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. IDs increase and are never reused after deletion. Completing a
task twice preserves its original completion timestamp. Dates must be real
calendar dates in `YYYY-MM-DD` format. List filters combine with AND; overdue
means an open task due strictly before the supplied date (or today's local date
for `stats`). Without a database, reads return empty results.
