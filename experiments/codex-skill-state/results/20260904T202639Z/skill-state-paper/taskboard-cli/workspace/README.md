# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are persisted between processes in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`. Updates use a sibling temporary file and atomic rename.

## Examples

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2027-01-15
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2027-01-16
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Set a custom database location for isolated boards or tests:

```sh
TASKBOARD_FILE=/tmp/my-board.json bun run src/cli.ts list
```

Each invocation writes exactly one JSON value to standard output. Errors also produce a diagnostic on standard error and exit with a nonzero status.
