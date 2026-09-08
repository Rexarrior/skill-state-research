# Taskboard CLI

A dependency-free, persistent task board for Bun.

## Run it

```sh
bun run taskboard.ts add "Write release notes" --description "Cover the new CLI"
bun run taskboard.ts move 1 in-progress
bun run taskboard.ts list
bun run taskboard.ts stats
```

You can also make the included launcher executable (`chmod +x taskboard`) and run
`./taskboard`, or link/install the package so `taskboard` is on your path.

## Commands

```text
taskboard add <title> [-d, --description <text>] [-s, --status <status>] [--json]
taskboard list [--status <status>] [--json]
taskboard show <id> [--json]
taskboard edit <id> [--title <title>] [-d, --description <text>] [--json]
taskboard move <id> <status> [--json]
taskboard remove <id> [--json]
taskboard clear --yes [--json]
taskboard stats [--json]
```

Valid statuses are `todo`, `in-progress`, and `done`. IDs are stable and are not
reused after deletion. Mutating commands write atomically, and invalid input exits
with status 1 without modifying the board.

By default data lives in `.taskboard.json` in the current working directory. Set
`TASKBOARD_FILE=/path/to/board.json` to choose another file, which is especially
useful for scripts and tests. The stored document is versioned JSON:

```json
{
  "version": 1,
  "nextId": 2,
  "tasks": [
    {
      "id": 1,
      "title": "Write release notes",
      "description": "Cover the new CLI",
      "status": "in-progress",
      "createdAt": "2026-09-08T12:00:00.000Z",
      "updatedAt": "2026-09-08T12:05:00.000Z"
    }
  ]
}
```

## Test

```sh
bun test
```
