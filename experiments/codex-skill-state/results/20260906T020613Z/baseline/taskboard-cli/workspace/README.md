# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when the variable is unset.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes exactly one JSON value to stdout. Errors also write a short diagnostic to stderr and exit non-zero. Database updates use a temporary sibling file followed by an atomic rename.

Run the self-tests with:

```sh
bun test
```
