# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`TASKBOARD_FILE`, or `.taskboard.json` in the current directory when the
environment variable is unset.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes one JSON value to stdout. Errors also write a concise
diagnostic to stderr and exit non-zero. Database updates use a sibling temporary
file followed by an atomic rename.

Run the self-tests with `bun test`.
