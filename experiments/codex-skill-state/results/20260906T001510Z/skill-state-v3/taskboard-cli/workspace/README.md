# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`.
Every successful command prints one JSON value; errors are written to stderr.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open
bun run src/cli.ts list --tag urgent --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates use `YYYY-MM-DD`.
Task IDs increase monotonically and are not reused after deletion. Database
writes use a temporary sibling file followed by an atomic rename.

Run the integration tests with:

```sh
bun test
```
