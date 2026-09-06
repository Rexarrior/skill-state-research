# Taskboard CLI

Dependency-free task manager for Bun. Each invocation writes exactly one JSON value to standard output; errors go to standard error.

```sh
bun run src/cli.ts add --title "Ship release" --tags release,urgent --due 2026-10-01
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Tasks are stored in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another path:

```sh
TASKBOARD_FILE=/tmp/tasks.json bun run src/cli.ts list --overdue 2026-10-01
```

Supported commands are `add`, `list`, `done`, `delete`, and `stats`. Tags are normalized to lowercase and deduplicated. Database writes use a sibling temporary file followed by rename.
