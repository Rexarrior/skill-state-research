# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or at the path specified by
`TASKBOARD_FILE`. Every command writes one JSON value to standard output.

## Examples

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-15
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Use a different database file:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

`add` accepts `--title`, optional comma-separated `--tags`, and optional
`--due YYYY-MM-DD`. `list` filters (`--status`, `--tag`, and `--overdue`) may be
combined. Invalid commands, flags, dates, task IDs, and malformed database files
exit non-zero; the existing database is never replaced in those cases.
