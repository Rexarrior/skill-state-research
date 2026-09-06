# Taskboard CLI

A dependency-free task manager written in TypeScript for Bun. Tasks are stored in
`.taskboard.json` in the current directory, or at the path in `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Tags are trimmed, lowercased, and deduplicated. Dates must be real calendar dates
in `YYYY-MM-DD` format. IDs increase monotonically and are not reused after a
deletion. `done` is idempotent and retains the original `completedAt` timestamp.

Every invocation writes one JSON value to stdout. On an error it writes an error
object to stdout, a diagnostic to stderr, and exits non-zero. Database updates use
a sibling temporary file followed by an atomic rename. The on-disk document has
the form `{ "version": 1, "nextId": 2, "tasks": [...] }` and is validated before
use; malformed data is never replaced.

Run the self-tests with:

```sh
bun test
```
