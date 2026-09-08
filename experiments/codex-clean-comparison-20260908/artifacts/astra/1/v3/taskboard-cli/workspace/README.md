# Taskboard CLI

A dependency-free TypeScript task manager. Requires Bun; no install step is needed.

```sh
bun run src/cli.ts add --title "Ship release" --tags Work,urgent,work --due 2026-09-30
bun run src/cli.ts list --status open --tag work --overdue 2026-10-01
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
bun test
```

Storage defaults to `.taskboard.json` in the current directory. Set `TASKBOARD_FILE`
to choose another path (its parent directory must exist). Writes use a sibling
temporary file and atomic rename. Run mutations sequentially; concurrent writers
are not coordinated.

Each invocation emits exactly one JSON value. `add`, `done`, and `delete` return
the affected task; `list` returns tasks sorted by ID; `stats` returns
`{total, open, done, overdue}`. Errors emit `{ "error": "..." }`, also report the
message to stderr, and exit nonzero. Invalid databases are never reset silently.

Titles are trimmed. Tags are trimmed, lowercased, deduplicated, and empty entries
are discarded. Dates must be real `YYYY-MM-DD` dates. List filters combine with
AND; overdue selects only open tasks due strictly before the supplied date.
Stats uses today's local date. Completing a task again preserves its original
completion timestamp. IDs increase monotonically and are not reused after deletion.

The storage document contains `version: 1`, `nextId`, and a `tasks` array. Each
task has `id`, `title`, `status`, ISO `createdAt`, `tags`, optional `due`, and ISO
`completedAt` when done. Do not edit the file while a command is running.
