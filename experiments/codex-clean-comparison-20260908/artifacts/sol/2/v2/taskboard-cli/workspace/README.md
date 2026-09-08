# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks persist between invocations in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates in `YYYY-MM-DD` form. Each invocation writes exactly one JSON value to stdout; failures also write a diagnostic to stderr and exit non-zero. Database updates use a sibling temporary file followed by an atomic rename.

To keep a board elsewhere:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```
