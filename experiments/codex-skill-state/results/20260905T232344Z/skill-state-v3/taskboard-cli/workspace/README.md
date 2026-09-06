# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`. Writes use a sibling temporary file followed by an atomic rename.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes exactly one JSON value to stdout on success. Errors are written to stderr and return a non-zero exit code. Tags are trimmed, lowercased, and deduplicated; due dates use `YYYY-MM-DD`.

To use another database file:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

## Tests

```sh
bun test
```
