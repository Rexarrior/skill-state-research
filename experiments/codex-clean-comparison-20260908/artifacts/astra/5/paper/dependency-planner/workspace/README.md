# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input: `{"tasks":[{"id":"lint","duration":1},{"id":"build","duration":3,"dependsOn":["lint"]}]}`.

Success prints one JSON object with `order`, `layers`, `earliest`, `totalDuration`, and `criticalPath`. Ready tasks and layers use ascending, case-sensitive string order. Layers reflect dependency depth; earliest times assume unlimited parallelism. Critical-path ties use the smallest full id sequence (a shorter prefix wins). A chain may start or end at a zero-duration boundary; nonempty inputs return a nonempty chain. Empty input tasks produce empty collections and duration 0.

IDs must be unique nonempty strings, durations finite and non-negative, and dependencies unique known IDs other than the task itself. Omitted dependencies default to `[]`. Invalid input, unreadable files, unknown commands/flags, cycles, and numeric time overflow produce stderr and a nonzero exit status. Cycles include a deterministic concrete dependency-to-dependent loop with the first node repeated. Use `./` before filenames starting with `-`.
