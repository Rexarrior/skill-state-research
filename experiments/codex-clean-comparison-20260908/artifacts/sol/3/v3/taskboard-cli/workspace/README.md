# Taskboard CLI

A small dependency-free task manager written in TypeScript for Bun. Tasks are stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every command prints one JSON value. Errors also print a JSON error value, write a diagnostic to stderr, and exit non-zero. Writes use a temporary sibling file followed by an atomic rename.

To keep separate taskboards, set the storage path per invocation:

```sh
TASKBOARD_FILE=/path/to/tasks.json bun run src/cli.ts list
```
