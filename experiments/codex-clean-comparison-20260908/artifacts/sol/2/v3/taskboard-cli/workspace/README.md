# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Each invocation emits one JSON value. Tasks are saved atomically in `.taskboard.json`, or at the path specified by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-15
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Dates use `YYYY-MM-DD`. Tags are trimmed, lowercased, and deduplicated. Filters on `list` combine with AND; overdue tasks are open tasks due strictly before the supplied date. Failed commands return a JSON error on stdout, explain the failure on stderr, and exit non-zero.

Run the self-tests with:

```sh
bun test
```
