# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation emits one JSON value on stdout. Errors are written to stderr and return a non-zero exit status. Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates in `YYYY-MM-DD` format.

To use another database:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Run the self-tests with:

```sh
bun test
```
