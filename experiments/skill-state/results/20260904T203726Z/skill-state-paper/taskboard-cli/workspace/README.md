# Taskboard CLI

A dependency-free task manager for Bun. Task data is written to `.taskboard.json` in the current directory, or to the path in `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Write docs" --tags work,docs --due 2026-10-01
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Every successful command prints one JSON value. Invalid input and missing tasks print diagnostics to stderr and exit non-zero.

Run self-tests with:

```sh
bun test test/cli.test.ts
```
