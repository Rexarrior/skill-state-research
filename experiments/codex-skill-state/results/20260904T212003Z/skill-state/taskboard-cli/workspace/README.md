# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in
`.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes one JSON value to stdout. Errors additionally write a diagnostic to
stderr and return a non-zero status. Tags are trimmed, lowercased, and deduplicated. Database
writes use a sibling temporary file followed by an atomic rename.

Run the self-tests with:

```sh
bun test
```
