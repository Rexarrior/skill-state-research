# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in `TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when that variable is unset. Database updates use an atomic sibling-file rename.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes one JSON value to standard output. Errors also produce a short diagnostic on standard error and a non-zero exit status. Tags are trimmed, lowercased, deduplicated, and matched case-insensitively.

Run the self-tests with:

```sh
bun test
```
