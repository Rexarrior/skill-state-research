# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each successful command writes one JSON value to stdout. Errors are written to stderr and return a non-zero exit status. Writes use a temporary sibling file followed by an atomic rename, so an interrupted update cannot partially overwrite the database.

Set a custom database for scripts or isolated projects:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```
