# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or in the path specified by `TASKBOARD_FILE`. Database updates use a sibling temporary file and atomic rename.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open
bun run src/cli.ts list --tag urgent --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes one JSON value to standard output. Errors also produce a short diagnostic on standard error and exit with a non-zero status. Tags are trimmed, lowercased, and deduplicated. Date arguments must be real calendar dates in `YYYY-MM-DD` form.

To keep the database elsewhere:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```

Run the self-tests with:

```sh
bun test
```
