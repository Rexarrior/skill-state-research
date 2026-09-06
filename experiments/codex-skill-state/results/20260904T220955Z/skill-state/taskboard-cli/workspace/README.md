# Taskboard CLI

Dependency-free task manager for Bun. Each command prints one JSON value to stdout.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Tasks are stored in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another location:

```sh
TASKBOARD_FILE=/tmp/tasks.json bun run src/cli.ts list
```

`list --overdue YYYY-MM-DD` returns open tasks due strictly before that date. Tags are trimmed, lower-cased, and deduplicated.
