# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are saved between processes in `TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when that variable is unset.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-15
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every command writes one JSON value to stdout. Errors also write a diagnostic to stderr and exit non-zero. Tags are trimmed, lowercased, and deduplicated; dates use the exact `YYYY-MM-DD` format.

Run the end-to-end self-test with:

```sh
bun test/self-test.ts
```
