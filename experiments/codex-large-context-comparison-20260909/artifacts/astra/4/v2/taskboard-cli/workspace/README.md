# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No installation of packages is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,release,work --due 2026-09-30
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Every invocation prints one JSON value: a task for `add`, `done`, and `delete`; an ascending-ID array for `list`; or `{total, open, done, overdue}` for `stats`. Errors print `{error: "..."}` to stdout, a diagnostic to stderr, and exit non-zero.

Tasks have a trimmed non-empty title, a stable positive integer ID, status, ISO creation timestamp, and tags. Tags are trimmed, lowercased, deduplicated, and empty entries removed. Due dates must be real calendar dates in `YYYY-MM-DD` format. Completing a task adds an ISO `completedAt`; repeating `done` preserves that timestamp. Deleted IDs are never reused.

List filters combine with AND. Overdue tasks must be open and have a due date strictly before the supplied date. Stats uses today's local calendar date for overdue counts.

Storage defaults to `.taskboard.json` in the current directory. To choose another path:

```sh
TASKBOARD_FILE=./personal.json bun run src/cli.ts add --title "Buy milk"
```

The JSON document contains `{version: 1, nextId, tasks}`. A missing file starts an empty board; malformed data causes an error and is preserved. Writes use a sibling temporary file followed by atomic rename. The parent directory must exist. Run modifying commands sequentially: concurrent writers are not coordinated.
