# Taskboard CLI

A small, dependency-free task manager written in TypeScript for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or in the path selected by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation emits one JSON value on stdout. Errors also write a short diagnostic to
stderr and return a non-zero exit status. Writes use a temporary sibling file followed by
an atomic rename, and malformed existing databases are never replaced.

Run the self-tests with:

```sh
bun test
```
