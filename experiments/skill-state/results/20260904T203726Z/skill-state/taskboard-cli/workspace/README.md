# Taskboard CLI

A dependency-free task manager for Bun. Data is stored in `.taskboard.json` in the current directory, or in the path specified by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Buy milk" --tags home,errands --due 2026-09-10
bun run src/cli.ts list --status open --tag home
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Each command prints one JSON value to standard output. Invalid commands, flags, dates, and missing tasks fail with a diagnostic on standard error.

Run the self-tests with:

```sh
bun test
```
