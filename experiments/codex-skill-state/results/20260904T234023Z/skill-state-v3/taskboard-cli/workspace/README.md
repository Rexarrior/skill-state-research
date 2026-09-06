# Taskboard CLI

A dependency-free task manager for Bun. Data is stored in `.taskboard.json` in
the current directory, or at the path supplied through `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship the release" --tags release,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each successful command writes exactly one JSON value to standard output. Errors
are written to standard error with a non-zero exit status. Task writes are atomic.
