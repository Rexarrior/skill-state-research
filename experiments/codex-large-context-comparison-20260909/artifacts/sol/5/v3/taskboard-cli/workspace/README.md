# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when that variable is unset.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-10-01
bun run src/cli.ts list --status open
bun run src/cli.ts list --tag work --overdue 2026-10-02
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes one JSON value to stdout. Errors also write a diagnostic to stderr and return a non-zero exit status. Database updates use a sibling temporary file followed by an atomic rename.

Run the integration tests with:

```sh
bun test
```
