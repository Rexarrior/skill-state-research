# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or at the path in
`TASKBOARD_FILE`. Each invocation writes one JSON value to standard output.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Date arguments must be real
calendar dates in `YYYY-MM-DD` form. Writes use a sibling temporary file followed
by an atomic rename, and malformed existing data is never replaced.

Run the process-level self-tests with:

```sh
bun test
```
