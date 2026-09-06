# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in `TASKBOARD_FILE`, or `.taskboard.json` in the current directory when that variable is unset. Writes use a sibling temporary file followed by an atomic rename.

## Examples

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every successful invocation writes exactly one JSON value to stdout. Errors are written to stderr and return a non-zero exit status. Tags are trimmed, lowercased, and deduplicated; list filters combine with AND.

Run the end-to-end test suite with:

```sh
bun test
```
