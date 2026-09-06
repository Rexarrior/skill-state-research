# Taskboard CLI

A dependency-free task manager for Bun. Data is stored in `.taskboard.json` in
the current directory, or in the file named by `TASKBOARD_FILE`.

```sh
bun run src/cli.ts add --title "Ship release" --tags release,urgent --due 2026-09-10
bun run src/cli.ts list --status open --tag urgent
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Every command emits one JSON value on standard output. Errors also emit a
diagnostic on standard error and exit with a non-zero status. Writes use a
temporary sibling file followed by an atomic rename.

Run the self-tests with:

```sh
bun test
```
