# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-15
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes exactly one JSON value to standard output. Errors also write a short diagnostic to standard error and return a non-zero exit status. Writes use a temporary sibling file followed by an atomic rename, and malformed existing data is never replaced.

To keep separate boards, set the storage path per invocation:

```sh
TASKBOARD_FILE=/path/to/team-board.json bun run src/cli.ts list
```
