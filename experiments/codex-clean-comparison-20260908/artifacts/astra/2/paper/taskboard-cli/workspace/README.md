# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No install step is needed.

```sh
bun run src/cli.ts add --title 'Ship release' --tags 'Work,release,work' --due 2026-10-01
bun run src/cli.ts list --status open --tag work --overdue 2026-10-02
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Data lives in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use another path (its parent directory must exist). Writes use a sibling
temporary file and atomic rename. Use one writer at a time; concurrent writers
are not coordinated.

Each invocation prints one JSON value. Add, done, and delete return the affected
task; list returns tasks sorted by ID; stats returns total, open, done, and overdue
counts. Failures print `null`, report a diagnostic to stderr, and exit non-zero.
Malformed data is rejected without overwriting it.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
removed. IDs increase and are never reused after deletion. Dates must be real
`YYYY-MM-DD` dates. List filters combine with AND; overdue includes only open
tasks due strictly before the specified date. Stats uses today's local date.
Completing an already completed task preserves its original completion time.

Run the process-level self-tests:

```sh
bun test
```
