# Taskboard CLI

A dependency-free task manager for Bun. Data is stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Each command writes exactly one JSON value to stdout. Errors are written to stderr and return a non-zero exit status. Taskboard writes are atomic.
