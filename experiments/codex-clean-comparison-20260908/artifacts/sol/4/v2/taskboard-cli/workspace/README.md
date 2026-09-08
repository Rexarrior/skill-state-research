# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in `TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when that variable is unset.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes one JSON value to standard output. Errors also produce a diagnostic on standard error and a non-zero exit status. Updates are persisted with an atomic sibling-file rename.

Run the self-tests with:

```sh
bun test
```
