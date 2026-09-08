# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Task data is stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`. Updates use a sibling temporary file and atomic rename.

## Usage

Run commands directly with Bun:

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-15
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

To use another database file:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Each invocation writes exactly one JSON value to standard output. Errors additionally write a concise diagnostic to standard error and exit with a non-zero status. Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates written as `YYYY-MM-DD`; overdue comparisons are strict (`due < date`).
