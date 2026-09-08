# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or in the path specified by `TASKBOARD_FILE`.

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

Set a different database file when needed:

```sh
TASKBOARD_FILE=/tmp/my-tasks.json bun run src/cli.ts list
```

Every successful command writes exactly one JSON value to standard output. Errors are written to standard error and return a non-zero exit status. Database updates use a sibling temporary file followed by an atomic rename.
