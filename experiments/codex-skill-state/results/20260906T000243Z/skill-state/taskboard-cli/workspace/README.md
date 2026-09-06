# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when that variable is unset.

```sh
bun run src/cli.ts add --title "Write release notes" --tags work,docs --due 2026-09-10
bun run src/cli.ts list --status open --tag docs
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes exactly one JSON value to stdout. Failures also write a short diagnostic to stderr and exit non-zero. Tags are trimmed, lowercased, and deduplicated. Dates use the exact `YYYY-MM-DD` format.

The data file is replaced atomically after successful mutations. IDs increase monotonically and are not reused after deletion. Run the self-tests with:

```sh
bun test
```
