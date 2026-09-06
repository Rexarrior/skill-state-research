# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes exactly one JSON value to stdout. Errors additionally write a concise diagnostic to stderr and exit with a non-zero status. Tags are trimmed, lowercased, and deduplicated. Dates use the strict `YYYY-MM-DD` format.

To keep a board elsewhere:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Database updates use a temporary sibling file followed by an atomic rename. A malformed database is rejected and left untouched.
