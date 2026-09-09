# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Each command prints one JSON value, making the CLI convenient for both people and scripts.

By default tasks are stored in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another path. Updates use a sibling temporary file followed by an atomic rename.

## Examples

```sh
bun run src/cli.ts add --title "Submit report" --tags work,urgent --due 2026-09-15
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates in `YYYY-MM-DD` form. Filters on `list` combine with AND; overdue results are always open tasks due strictly before the supplied date.

On failure the process exits non-zero, writes a diagnostic to stderr, and prints a JSON error object to stdout. Existing malformed data is never overwritten.

## Tests

```sh
bun test
```
