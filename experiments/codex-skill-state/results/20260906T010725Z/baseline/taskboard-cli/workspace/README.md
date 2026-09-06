# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when that
variable is not set. Every command writes one JSON value to stdout.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar
dates in `YYYY-MM-DD` form. Failed commands exit non-zero, emit a JSON error to
stdout, and leave existing storage untouched.

Run the self-tests with:

```sh
bun test
```
