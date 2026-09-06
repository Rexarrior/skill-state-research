# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or at the path specified by
`TASKBOARD_FILE`. Updates use a same-directory temporary file and atomic rename.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. All filters on `list` combine
with AND. Each invocation writes exactly one JSON value to standard output;
errors also write a short diagnostic to standard error and exit non-zero.

To keep a board somewhere else:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```
