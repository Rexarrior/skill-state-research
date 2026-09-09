# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No installation of packages is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent,work" --due 2026-10-01
bun run src/cli.ts list --status open --tag work --overdue 2026-10-02
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another file (its parent directory must exist):

```sh
TASKBOARD_FILE=team.json bun run src/cli.ts list
```

Each invocation writes exactly one JSON value to stdout. `add`, `done`, and `delete` return the affected task; `list` returns tasks in ascending ID order; `stats` returns `{total, open, done, overdue}`. Errors return `{error: "..."}`, write a diagnostic to stderr, and exit nonzero.

Titles are trimmed and must be nonempty. Tags are trimmed, lowercased, deduplicated, and empty entries discarded. Dates must be real calendar dates in `YYYY-MM-DD` format. Filters combine with AND; overdue selects only open tasks due strictly before the supplied date. Stats uses today's local date. Completing a task again preserves its original completion timestamp.

The database contains `{version: 1, nextId, tasks}`. IDs increase and are never reused after deletion. Invalid databases are rejected without modification. Mutations write a sibling temporary file and rename it atomically; simultaneous writers are not supported (run mutations sequentially).
