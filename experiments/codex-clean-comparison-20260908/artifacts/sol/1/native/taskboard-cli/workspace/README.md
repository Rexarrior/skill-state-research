# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or in the path specified by `TASKBOARD_FILE`. Each invocation emits one JSON value.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, de-duplicated, and matched case-insensitively. Dates use the calendar format `YYYY-MM-DD`; overdue comparisons are strict. IDs increase monotonically and are not reused after deletion. Writes use a temporary sibling followed by an atomic rename.

Run the self-tests with:

```sh
bun test
```
