# Taskboard CLI

A dependency-free TypeScript task manager for Bun. Run from the project directory:

```sh
bun run src/cli.ts add --title "Ship release" --tags "Work, urgent,work" --due 2026-09-30
bun run src/cli.ts list
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Storage defaults to `.taskboard.json` in the current directory. Override it with
`TASKBOARD_FILE=./my-tasks.json bun run src/cli.ts list`. The parent directory must
exist. Writes use a sibling temporary file and an atomic rename. The database
contains `{nextId, tasks}`; IDs increase and are never reused after deletion.
Use one writer at a time; concurrent writes are not coordinated.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
are discarded. Dates must be real calendar dates in `YYYY-MM-DD` format. List
filters combine with AND; overdue selects only open tasks due strictly before
the supplied date. Stats uses today's local date for overdue counts.

Each invocation prints one JSON value: add/done/delete return the affected task,
list returns an array in ID order, and stats returns counts. Repeating done
preserves the original completion timestamp. Errors print `{ "error": "..." }`
to stdout, a diagnostic to stderr, and exit non-zero. Invalid arguments, missing
tasks, and malformed databases leave stored data unchanged.

Run the process-level self-tests with `bun test`.
