# Taskboard CLI

A small, dependency-free task manager written in TypeScript for Bun. Tasks are
stored in `.taskboard.json` in the current directory, or in the path selected by
`TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each successful invocation writes one JSON value to standard output. `add`,
`done`, and `delete` return the affected task; `list` returns an array and
`stats` returns counts. Errors are written to standard error and use a non-zero
exit status. Database updates use an atomic sibling-file rename.

To keep a board elsewhere:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```
