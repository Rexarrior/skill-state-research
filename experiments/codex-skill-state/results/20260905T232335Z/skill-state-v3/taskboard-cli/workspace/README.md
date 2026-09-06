# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when that variable is unset. Database updates use a sibling temporary file and an atomic rename.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Date arguments must be real calendar dates in `YYYY-MM-DD` format. Each invocation emits one JSON value; errors also write a diagnostic to stderr and exit non-zero.

Run the self-tests with:

```sh
bun test
```
