# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or at `TASKBOARD_FILE` when set.
Every invocation emits one JSON value.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Dates use strict `YYYY-MM-DD` format. Tags are trimmed, lowercased, and
deduplicated. Writes use a temporary sibling file followed by an atomic rename;
malformed databases and invalid commands fail without overwriting stored data.

Run the self-tests with:

```sh
bun test
```
