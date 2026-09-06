# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are kept in `.taskboard.json` in the current directory, or in the path specified by `TASKBOARD_FILE`. Database updates use an atomic temporary-file-and-rename operation.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes exactly one JSON value to stdout. Errors also write a diagnostic to stderr and exit non-zero. `add`, `done`, and `delete` return the affected task; `list` returns tasks ordered by ID; `stats` returns counts.

Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates in `YYYY-MM-DD` format. IDs are never reused after deletion.

Run the cross-process self-tests with:

```sh
bun test
```
