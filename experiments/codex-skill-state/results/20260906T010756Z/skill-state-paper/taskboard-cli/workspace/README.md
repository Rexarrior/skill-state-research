# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at `TASKBOARD_FILE` when that environment variable is set. Database updates use a sibling temporary file and an atomic rename.

```sh
bun run src/cli.ts add --title "Write release notes" --tags docs,release --due 2026-09-10
bun run src/cli.ts list --status open --tag docs
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every command writes exactly one JSON value to stdout. Errors also write a diagnostic to stderr and exit non-zero. Tags are trimmed, lowercased, and deduplicated. List filters combine with AND; overdue filtering includes only open tasks due strictly before the supplied date.

Run the self-tests with:

```sh
bun test
```
