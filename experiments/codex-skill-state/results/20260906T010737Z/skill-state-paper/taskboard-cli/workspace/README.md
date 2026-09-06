# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Each invocation writes exactly one JSON value to stdout; errors also produce a diagnostic on stderr and a non-zero exit code.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Data is stored in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another path:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Writes use a temporary sibling file followed by an atomic rename. IDs increase monotonically and are not reused after deletion. Tags are trimmed, lowercased, and deduplicated.

## Tests

```sh
bun test
```
