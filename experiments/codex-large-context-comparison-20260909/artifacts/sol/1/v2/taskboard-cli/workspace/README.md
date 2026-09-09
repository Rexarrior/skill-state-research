# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are stored in `.taskboard.json` in the current directory, or at the path specified by `TASKBOARD_FILE`. Updates use a sibling temporary file and an atomic rename.

```sh
bun run src/cli.ts add --title "Write release notes" --tags work,release --due 2030-06-01
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2030-07-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes exactly one JSON value to stdout. On failure it also writes a concise diagnostic to stderr and exits non-zero. Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates in `YYYY-MM-DD` form.

Run the self-tests with:

```sh
bun test
```
