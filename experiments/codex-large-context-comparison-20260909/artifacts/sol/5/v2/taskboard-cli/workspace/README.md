# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`.
Each invocation writes one JSON value to standard output.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates use `YYYY-MM-DD` and are
validated as calendar dates. Filters on `list` combine with AND; overdue tasks
must be open and have a due date strictly earlier than the supplied date.

Set a custom database path for any invocation:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Run the end-to-end tests with:

```sh
bun test
```
