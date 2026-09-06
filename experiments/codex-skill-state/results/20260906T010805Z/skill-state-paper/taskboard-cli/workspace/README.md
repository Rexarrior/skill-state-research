# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or at the path specified by
`TASKBOARD_FILE`.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar
dates in `YYYY-MM-DD` format. All filters passed to `list` are combined with
AND. Output is exactly one JSON value; failures also write a diagnostic to
stderr and exit non-zero.

Writes use a temporary sibling file followed by an atomic rename. The database
is validated before use, and task IDs are never reused after deletion.
