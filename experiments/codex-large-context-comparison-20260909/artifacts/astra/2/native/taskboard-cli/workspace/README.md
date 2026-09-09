# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun; no install step is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent, work" --due 2026-09-15
bun run src/cli.ts list --status open --tag work --overdue 2026-09-16
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to choose another path (its parent directory must exist):

```sh
TASKBOARD_FILE=personal.json bun run src/cli.ts list
bun test
```

Each invocation prints exactly one JSON value. `add`, `done`, and `delete` return
the affected task; `list` returns an array; `stats` returns counts. Errors return
`{"error":"..."}`, print a diagnostic to stderr, and exit non-zero.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format (years
0001–9999). Filters combine with AND; overdue includes only open tasks due strictly
before the supplied date. Statistics use today's local date. Completing a task
again preserves its original completion timestamp.

The versioned JSON database retains an increasing ID counter, even after deletion.
Writes use a sibling temporary file and atomic rename. Invalid databases are
rejected without replacement. Concurrent writers are not coordinated; run mutation
commands sequentially.
