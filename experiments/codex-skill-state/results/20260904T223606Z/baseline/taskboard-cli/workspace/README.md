# Taskboard CLI

A dependency-free task manager for Bun. Tasks are stored in `.taskboard.json` in
the current directory, or at the path set in `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Send report" --tags Work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-10
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Each command writes one JSON value to stdout. Errors are written to stderr and
exit with a non-zero status. Task data is written atomically through a sibling
temporary file, so an interrupted write does not replace the database.

## Self-test

```sh
bun test
```
