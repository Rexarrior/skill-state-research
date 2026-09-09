# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or in the path selected by
`TASKBOARD_FILE`. Database updates use a sibling temporary file and an atomic
rename.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2027-01-15
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2027-02-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes one JSON value to standard output. Errors also write a
short diagnostic to standard error and exit with a non-zero status. Tags are
trimmed, lowercased, deduplicated, and empty comma-separated entries are ignored.

To keep data somewhere else:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Run the self-tests with `bun test`.
