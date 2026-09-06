# Taskboard CLI

A dependency-free TypeScript task manager for [Bun](https://bun.sh/). Tasks are kept in `.taskboard.json` in the current directory, or at the path selected by `TASKBOARD_FILE`. Updates use a sibling temporary file followed by an atomic rename.

## Usage

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-09-30
bun run src/cli.ts list --status open --tag work
bun run src/cli.ts list --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts delete 1
bun run src/cli.ts stats
```

Every invocation writes one JSON value to stdout. On failure it writes an `{\"error\": ...}` value, emits a concise diagnostic to stderr, and exits non-zero. Tags are trimmed, lowercased, and deduplicated. Deleted IDs are not reused.

## Tests

```sh
bun test
```

The integration tests launch the CLI in separate processes and cover persistence, filtering, date validation, idempotence, statistics, malformed storage, and failure output.
