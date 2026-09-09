# Taskboard CLI

A small, dependency-free task manager written in TypeScript for Bun. Tasks are
stored in `.taskboard.json` in the current directory, or at the path specified
by `TASKBOARD_FILE`. Database updates use a sibling temporary file followed by
an atomic rename.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates use the exact
`YYYY-MM-DD` format. Each invocation writes one JSON value to stdout; errors
also produce a concise diagnostic on stderr and a non-zero exit status.

To keep a board somewhere else:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```
