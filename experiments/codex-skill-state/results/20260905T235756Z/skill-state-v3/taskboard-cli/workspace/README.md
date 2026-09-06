# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are
stored in `.taskboard.json` in the current directory, or at `TASKBOARD_FILE` when
that environment variable is set. Database writes use a sibling temporary file
and an atomic rename.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation emits exactly one JSON value on stdout. On failure it emits a
JSON error object, writes a diagnostic to stderr, and exits non-zero. Dates must
be real calendar dates in `YYYY-MM-DD` format; tags are trimmed, lowercased, and
deduplicated.

Run the self-tests with:

```sh
bun test
```
