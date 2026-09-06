# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`. Database updates use a sibling temporary file followed by an atomic rename.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes exactly one JSON value to stdout. Errors also write a short diagnostic to stderr and exit non-zero. Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates in `YYYY-MM-DD` form.

To use another database:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

## Tests

```sh
bun test
```
