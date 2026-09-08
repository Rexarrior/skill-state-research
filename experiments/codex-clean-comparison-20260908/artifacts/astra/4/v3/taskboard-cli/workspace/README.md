# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No install step is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags work,urgent --due 2026-10-01
bun run src/cli.ts list --status open --tag work --overdue 2026-10-02
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use another path (its parent directory must exist):

```sh
TASKBOARD_FILE=team.json bun run src/cli.ts list
```

Each invocation writes exactly one JSON value to stdout: `add`, `done`, and
`delete` return the affected task; `list` returns an array sorted by ID; `stats`
returns `{total, open, done, overdue}`. Errors return `{error: "..."}`, also write
a diagnostic to stderr, and exit nonzero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format.
List filters combine with AND; overdue selects only open tasks due strictly
before the supplied date. Stats uses today's local date. Completing an already
done task preserves its original completion timestamp.

The versioned JSON database keeps a monotonic ID counter, so deleted IDs are
never reused. Writes use a sibling temporary file and atomic rename. Invalid
input or corrupt databases fail without replacing stored data. Run one writer
at a time; concurrent writes are not coordinated.
