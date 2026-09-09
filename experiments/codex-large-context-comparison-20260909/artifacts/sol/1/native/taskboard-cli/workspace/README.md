# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Task data is stored in `TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when that variable is unset. Database writes use a sibling temporary file followed by an atomic rename.

Run commands with:

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,Urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates in `YYYY-MM-DD` form. Each invocation writes exactly one JSON value to stdout; errors additionally write a short diagnostic to stderr and exit non-zero.

To keep data elsewhere:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Run the self-tests with `bun test`.
