# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No installation of packages is required.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent,work" --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Each invocation prints exactly one JSON value. `add`, `done`, and `delete` return the affected task; `list` returns an array sorted by ID. Failures return `{"error":"..."}`, print a diagnostic to stderr, and exit non-zero. Repeating `done` preserves the original completion timestamp.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries removed. Dates must be real calendar dates in `YYYY-MM-DD` format (years 0001–9999). List filters combine with AND; overdue selects only open tasks due strictly before the given date. Stats uses today's local date for overdue counts.

Data lives in `.taskboard.json` in the working directory, or at the path supplied by `TASKBOARD_FILE`:

```sh
TASKBOARD_FILE=./personal.json bun run src/cli.ts add --title "Buy groceries"
bun test
```

The JSON database contains `version`, `nextId`, and `tasks`. IDs are persistent and never reused after deletion. Writes use a temporary sibling file followed by an atomic rename; malformed data is rejected without replacement. The destination directory must already exist. Run one writing command at a time; concurrent writers are not serialized.
