# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every command writes one JSON value to stdout. Errors also write a diagnostic to
stderr and exit non-zero. Database updates use a temporary sibling file followed
by an atomic rename. IDs increase monotonically and are not reused after deletion.

Run the process-level self-tests with:

```sh
bun test
```
