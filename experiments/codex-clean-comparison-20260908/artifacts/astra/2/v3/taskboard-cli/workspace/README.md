# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Run commands from the project directory:

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
TASKBOARD_FILE=./personal.json bun run src/cli.ts list
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another path; its parent directory must exist. Updates use a sibling temporary file and atomic rename. Run one writer at a time; concurrent updates are not coordinated.

Each invocation writes exactly one JSON value to stdout: a task for `add`, `done`, and `delete`, an array for `list`, or `{total, open, done, overdue}` for `stats`. Errors print `null` to stdout, a diagnostic to stderr, and exit non-zero. Invalid databases are rejected without replacement.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries removed. Dates must be real calendar dates in `YYYY-MM-DD` format. List filters combine with AND; overdue means an **open** task with a due date strictly before the supplied day. Stats uses today's local date. IDs increase and are never reused after deletion. Repeating `done` preserves the original completion timestamp.
