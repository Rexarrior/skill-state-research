# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or in the path specified by
`TASKBOARD_FILE`. Every command writes one JSON value to stdout.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,Urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates use `YYYY-MM-DD` and are
validated as calendar dates. Writes use a temporary sibling file followed by an
atomic rename. Invalid commands, flags, dates, IDs, or database contents return a
non-zero exit status without replacing the database; an error object is printed
to stdout and a diagnostic to stderr.
