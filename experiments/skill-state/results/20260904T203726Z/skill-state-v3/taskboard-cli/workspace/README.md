# Taskboard CLI

Dependency-free task manager for Bun. Each command prints one JSON value.

```sh
bun run src/cli.ts add --title "Buy milk" --tags Home,errands --due 2026-09-10
bun run src/cli.ts list --status open --tag home
bun run src/cli.ts done 1
bun run src/cli.ts stats
bun run src/cli.ts delete 1
```

Tasks are stored in `.taskboard.json` in the current directory. Set `TASKBOARD_FILE` to use another file.

Run the self-tests with `bun test`.
