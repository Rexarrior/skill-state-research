# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Task data is stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`. Updates use a sibling temporary file and an atomic rename.

## Examples

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

All commands print one JSON value to standard output. Errors also write a short diagnostic to standard error and exit non-zero. Tags are trimmed, lowercased, and deduplicated. Date arguments must be real calendar dates in `YYYY-MM-DD` form.

To keep data somewhere else:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```
