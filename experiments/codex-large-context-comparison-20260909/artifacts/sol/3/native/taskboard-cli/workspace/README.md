# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or in the path given by
`TASKBOARD_FILE`. Updates use a sibling temporary file and an atomic rename.

```sh
bun run src/cli.ts add --title "Write release notes" --tags work,writing --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes exactly one JSON value to stdout. Errors also write a
short diagnostic to stderr and exit non-zero. Tags are trimmed, lowercased,
deduplicated, and matched case-insensitively. IDs are never reused after a task
is deleted.

Run the self-tests with:

```sh
bun test
```
