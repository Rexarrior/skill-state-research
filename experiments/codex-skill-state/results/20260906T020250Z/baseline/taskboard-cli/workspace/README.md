# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or at `TASKBOARD_FILE` when
that environment variable is set. Each command prints one JSON value.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,Urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Date arguments must be real
calendar dates in `YYYY-MM-DD` form. Writes replace the database atomically;
invalid commands or a malformed existing database fail without overwriting it.

Run the self-tests with:

```sh
bun test
```
