# Taskboard CLI

A dependency-free task manager for Bun. Data is stored in `.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-12
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-10
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each successful command writes exactly one JSON value to standard output. Errors are written to standard error and return a non-zero exit status. Tags are trimmed, lower-cased, and deduplicated. Storage writes use a sibling temporary file followed by an atomic rename.
