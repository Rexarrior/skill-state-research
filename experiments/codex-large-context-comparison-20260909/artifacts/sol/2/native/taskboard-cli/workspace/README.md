# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`. Every command writes one JSON value to standard output, making the CLI easy to script.

## Examples

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2030-05-20
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2030-06-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Set a different database file for an invocation (or export it for several invocations):

```sh
TASKBOARD_FILE=/tmp/my-tasks.json bun run src/cli.ts list
```

Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates in `YYYY-MM-DD` format. Filters on `list` combine with AND; overdue filtering includes only open tasks with a due date strictly earlier than the supplied date. IDs are never reused after deletion.

Failures return a JSON object such as `{"error":"Task 99 not found"}` on stdout, print a short diagnostic on stderr, and exit non-zero. A malformed database is rejected without being overwritten.
