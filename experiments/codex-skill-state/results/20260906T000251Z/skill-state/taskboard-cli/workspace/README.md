# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when the
variable is unset. Writes use a temporary sibling file followed by an atomic
rename.

```sh
bun run src/cli.ts add --title "Prepare release" --tags work,urgent --due 2030-04-15
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2030-05-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. `add` and `done` print the
resulting task, `delete` prints `{ "deleted": ID }`, `list` prints an array,
and `stats` prints its counters. Every invocation emits exactly one JSON value
to stdout. Errors additionally write a diagnostic to stderr and exit non-zero.

Run the integration tests with:

```sh
bun test
```
