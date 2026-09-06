# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes exactly one JSON value to stdout. Errors also write a concise diagnostic to stderr and exit non-zero. Tags are trimmed, converted to lowercase, and deduplicated. Date values must be real calendar dates in `YYYY-MM-DD` format.

To keep task data elsewhere:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Database updates use a sibling temporary file followed by an atomic rename. A missing database is treated as an empty task board; malformed or structurally invalid data is rejected and never replaced silently.
