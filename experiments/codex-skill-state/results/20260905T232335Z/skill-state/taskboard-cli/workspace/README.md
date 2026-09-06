# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`.
All command results are JSON.

```sh
bun run src/cli.ts add --title "Write release notes" --tags docs,release --due 2026-09-10
bun run src/cli.ts list --status open --tag docs
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar
dates in `YYYY-MM-DD` format. Writes use a temporary sibling followed by an
atomic rename, so an interrupted write does not replace the database.

Run the integration tests with:

```sh
bun test
```
