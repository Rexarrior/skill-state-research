# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or in the path specified by
`TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,Urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes exactly one JSON value to standard output. Errors also
write a diagnostic to standard error and exit with a non-zero status. Database
writes use a temporary sibling file followed by an atomic rename.
