# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or in the path selected by
`TASKBOARD_FILE`. Database updates use a sibling temporary file followed by an
atomic rename.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes exactly one JSON value to stdout. Errors also produce a
diagnostic on stderr and a non-zero exit status. Titles must be non-empty, dates
must be real calendar dates in `YYYY-MM-DD` form, tags are trimmed, lowercased,
and deduplicated, and list filters combine with AND.
