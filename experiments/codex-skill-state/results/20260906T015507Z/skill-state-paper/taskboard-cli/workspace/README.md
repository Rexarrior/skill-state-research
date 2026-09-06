# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Data is stored in `TASKBOARD_FILE`, or in `.taskboard.json` in the current directory when that environment variable is unset.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every successful invocation writes exactly one JSON value to stdout. Errors are written to stderr and return a non-zero exit status. Dates use `YYYY-MM-DD`; tags are trimmed, lowercased, de-duplicated, and matched case-insensitively.

Database updates use a temporary sibling file followed by an atomic rename. Existing malformed data is rejected and never silently replaced.

Run the self-tests with:

```sh
bun test
```
