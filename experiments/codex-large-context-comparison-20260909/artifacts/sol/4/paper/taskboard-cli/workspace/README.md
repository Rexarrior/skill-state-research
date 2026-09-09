# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or at the path given by
`TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation emits exactly one JSON value on standard output. Errors are
written to standard error and return a non-zero exit status. Writes use a
sibling temporary file followed by an atomic rename, so an existing database
is not partially overwritten.

Tags are trimmed, lowercased, and de-duplicated. Dates use the strict
`YYYY-MM-DD` format. `list --overdue DATE` returns open tasks due strictly
before `DATE`; `stats` compares against today's local date.
