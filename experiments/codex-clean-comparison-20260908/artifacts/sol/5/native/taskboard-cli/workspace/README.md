# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or in the path named by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes one JSON value to stdout. Errors exit non-zero, write `null` to stdout, and put a concise explanation on stderr. Tags are trimmed, lowercased, and deduplicated. Date arguments must be real calendar dates in `YYYY-MM-DD` form.

The database is validated before use and replaced atomically through a sibling temporary file. Its persisted `nextId` counter prevents deleted IDs from being reused.

Run the self-tests with:

```sh
bun test
```
