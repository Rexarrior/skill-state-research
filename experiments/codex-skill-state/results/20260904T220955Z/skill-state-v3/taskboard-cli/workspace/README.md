# Taskboard CLI

A dependency-free task manager for Bun. Data is stored in `.taskboard.json` in the current directory, or in the path set by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Write release notes" --tags docs,release --due 2026-10-01
bun run src/cli.ts list --status open --tag docs
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Each command emits exactly one JSON value to stdout. Invalid commands, flags, dates, IDs, and malformed database files produce a diagnostic on stderr and a non-zero exit code. Database writes use a sibling temporary file followed by an atomic rename.

## Self-test

```sh
bun test
```
