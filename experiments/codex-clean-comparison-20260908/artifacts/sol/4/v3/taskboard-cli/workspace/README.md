# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or at the path specified by
`TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes one JSON value to standard output. Errors also write a
short diagnostic to standard error and return a non-zero exit status. Database
writes use a temporary sibling file followed by an atomic rename.
