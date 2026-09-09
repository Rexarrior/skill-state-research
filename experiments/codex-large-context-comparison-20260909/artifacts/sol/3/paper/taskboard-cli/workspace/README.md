# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path set by `TASKBOARD_FILE`.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open
bun run src/cli.ts list --tag urgent --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates use the `YYYY-MM-DD` format. Every command writes one JSON value to standard output; errors also produce a diagnostic on standard error and a non-zero exit status.

To keep a board elsewhere:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Database updates use a temporary sibling file followed by an atomic rename. IDs increase monotonically and are not reused after deletion.
