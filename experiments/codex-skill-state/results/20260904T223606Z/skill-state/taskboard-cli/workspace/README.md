# Taskboard CLI

A dependency-free task manager for Bun. Data is stored in `.taskboard.json` in
the current directory, or in the file named by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Write release notes" --tags docs,Release --due 2026-09-10
bun run src/cli.ts list --status open --tag release
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Every invocation emits exactly one JSON value on standard output. Errors also
write a short diagnostic to standard error and exit non-zero. Dates must be real
calendar dates in `YYYY-MM-DD` form. Tags are trimmed, lower-cased, and made
unique. Taskboard writes are atomic: it writes a sibling temporary file and
renames it into place.

To keep taskboards elsewhere:

```sh
TASKBOARD_FILE=/tmp/work-tasks.json bun run src/cli.ts list
```
