# Taskboard CLI

A small, dependency-free task manager written in TypeScript for Bun. Tasks are
stored between invocations in `TASKBOARD_FILE`, or in `.taskboard.json` in the
current directory when that environment variable is not set.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Set a custom database location for an invocation or shell session:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Every command writes exactly one JSON value to standard output. On failure it
writes a JSON error object to standard output, a diagnostic to standard error,
and exits with a nonzero status. Database updates use a sibling temporary file
and an atomic rename, so an interrupted write cannot leave a partial document.
