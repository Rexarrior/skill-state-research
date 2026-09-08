# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-15
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-09-20
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Each invocation writes one JSON value to stdout. Errors also exit non-zero and
write a diagnostic to stderr. Tags are trimmed, Unicode-normalized, lowercased,
and deduplicated. Overdue date comparisons are strict (`due < date`), and only
open tasks qualify. Writes use a temporary sibling file followed by an atomic
rename.

Run the self-tests with:

```sh
bun test
```
