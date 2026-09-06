# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or in the path specified by `TASKBOARD_FILE`. Database updates use a sibling temporary file followed by an atomic rename.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation emits exactly one JSON value on stdout. Errors also write a diagnostic to stderr and exit non-zero. Dates must be real calendar dates in `YYYY-MM-DD` format; tags are trimmed, lowercased, and deduplicated.

Run the self-tests with:

```sh
bun test
```
