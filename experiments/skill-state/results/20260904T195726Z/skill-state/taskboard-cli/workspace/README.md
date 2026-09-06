# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Data is stored in
`.taskboard.json` in the current directory, or at `TASKBOARD_FILE` when set.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-11
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes one JSON value to stdout. Errors also write a diagnostic
to stderr and exit non-zero. Updates use a sibling temporary file and atomic
rename; a sibling lock directory prevents concurrent writers from losing data.

Run the end-to-end test suite with:

```sh
bun test
```
