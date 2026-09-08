# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun.

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, release,work" --due 2026-09-30
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to choose another file (its parent directory must exist). Writes use a sibling
temporary file followed by atomic rename. Use one writer at a time; simultaneous
writers are not coordinated.

Each invocation prints one JSON value: a task for `add`, `done`, and `delete`,
an array for `list`, or `{total, open, done, overdue}` for `stats`. Failures print
`{"error":"..."}`, also report the diagnostic on stderr, and exit non-zero.
Invalid databases are rejected without overwriting them.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty tags
are removed. IDs increase and are never reused after deletion. Completing a task
again preserves its completion timestamp. Dates must be real `YYYY-MM-DD` dates.
List filters combine with AND; overdue selects only open tasks due strictly before
the supplied date. Stats uses today's local date for the same comparison.
