# Taskboard CLI

A dependency-free TypeScript task manager for Bun. No installation of packages is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-30
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to use another path (its parent directory must exist). Writes use a sibling temporary
file and atomic rename. Run modifying commands sequentially; concurrent writers are
not coordinated.

Each invocation prints exactly one JSON value: `add`, `done`, and `delete` return the
affected task; `list` returns an array sorted by ID; `stats` returns counts. Errors
print `null` to stdout, a diagnostic to stderr, and exit nonzero. Missing tasks,
invalid databases, unknown or duplicate flags, and invalid arguments are errors.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
removed. Dates must be real `YYYY-MM-DD` dates. List filters combine with AND;
overdue includes only open tasks due strictly before the supplied date. Stats uses
today's local date. Completing a task twice preserves its completion timestamp.
IDs increase monotonically and are never reused after deletion.
