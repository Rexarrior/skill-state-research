# Taskboard CLI

Build a dependency-free TypeScript command-line task manager for Bun.

## Entry point and storage

- The entry point must be `src/cli.ts` and run as `bun run src/cli.ts ...`.
- Persist a JSON document on disk. Use `TASKBOARD_FILE` when set, otherwise `.taskboard.json` in the current directory.
- Writes must be atomic (write a sibling temporary file and rename it).
- Every invocation prints exactly one JSON value to stdout. Diagnostics go to stderr and failures exit non-zero.

## Commands

- `add --title TEXT [--tags a,b] [--due YYYY-MM-DD]`
  - Creates a task with a stable integer `id`, `status: "open"`, ISO `createdAt`, unique normalized tags, and optional due date.
  - Empty titles and impossible dates are errors.
- `list [--status open|done] [--tag TAG] [--overdue YYYY-MM-DD]`
  - Prints a JSON array sorted by ascending id.
  - Filters combine with AND. `--overdue D` selects open tasks whose due date is strictly before D.
- `done ID`
  - Marks an existing task done and adds ISO `completedAt`. Repeating it is idempotent.
- `delete ID`
  - Deletes an existing task.
- `stats`
  - Prints `{total, open, done, overdue}`. For this command, overdue means before today's local `YYYY-MM-DD`.

The database must survive separate processes. A malformed database, unknown command/flag, or missing task must fail
without silently replacing data. Include a concise `README.md` with examples and run meaningful self-tests before
finishing.
