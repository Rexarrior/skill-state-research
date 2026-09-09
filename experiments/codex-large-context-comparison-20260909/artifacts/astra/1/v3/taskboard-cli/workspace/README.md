# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Run commands from this directory:

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work,release,work" --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another path (its parent directory must exist):

```sh
TASKBOARD_FILE=./personal.json bun run src/cli.ts list
```

Each invocation prints one JSON value. Add, done, and delete return the affected task; list returns tasks in ID order; stats returns `{total, open, done, overdue}`. Errors print `{error: "..."}` to stdout, a diagnostic to stderr, and exit non-zero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries removed. Dates must be real calendar dates in `YYYY-MM-DD` format. List filters combine with AND; overdue includes only open tasks due strictly before the supplied date. Stats uses today's local date. Completing a task twice preserves its original completion timestamp.

Storage is a versioned JSON document with `nextId` and `tasks`. IDs remain stable and are never reused after deletion. Malformed databases are rejected without replacement. Writes use a sibling temporary file followed by atomic rename. Run mutating commands sequentially; concurrent writers are not coordinated.
