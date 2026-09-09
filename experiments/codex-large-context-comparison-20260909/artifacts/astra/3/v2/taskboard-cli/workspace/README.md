# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun.

```sh
bun run src/cli.ts add --title "Write release notes" --tags Work,writing,work --due 2026-10-01
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag work --overdue 2026-10-02
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
TASKBOARD_FILE=./personal.json bun run src/cli.ts list
bun test
```

Data lives in `.taskboard.json` in the current directory, or the path in
`TASKBOARD_FILE`. Its parent directory must already exist. Writes use a sibling
temporary file followed by an atomic rename. Run modifying commands sequentially;
concurrent writers are not coordinated.

Every command prints one JSON value. `add`, `done`, and `delete` return the task;
`list` returns tasks sorted by ID; `stats` returns `{total, open, done, overdue}`.
Errors print `{ "error": "..." }`, also emit diagnostics on stderr, and exit nonzero.
Missing files start an empty board; malformed files are rejected without replacement.
IDs increase and are not reused after deletion.

Titles are trimmed and must be nonempty. Tags are trimmed, lowercased, deduplicated,
and empty entries are removed. Dates must be real calendar dates in `YYYY-MM-DD`
format. List filters combine with AND. Overdue tasks must be open and due strictly
before the supplied date (or today's local date for `stats`). Completing a task
again preserves its original completion timestamp. Timestamps are ISO UTC strings.
