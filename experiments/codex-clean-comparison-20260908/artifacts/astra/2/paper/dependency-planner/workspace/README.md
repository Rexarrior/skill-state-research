# Dependency Planner

A dependency-free TypeScript CLI for Bun.

```sh
bun run src/cli.ts plan INPUT.json
bun test
```

Input is an object containing a `tasks` array. Each task has a unique non-empty
string `id`, a finite non-negative numeric `duration`, and optional `dependsOn`
(an array of unique known task ids, defaulting to `[]`). Self-dependencies are invalid.

Success prints one JSON object containing a lexicographically chosen topological
`order`, sorted dependency-depth `layers`, per-task `earliest` start/finish times,
`totalDuration`, and the lexicographically smallest maximum-duration dependency
chain as `criticalPath`. Lexicographic comparisons use JavaScript string ordering.
A shorter chain wins over an extension of the same prefix, including zero-duration
extensions. Nonempty graphs return a nonempty chain; empty graphs return `[]`.
Durations use JavaScript numbers; a schedule that overflows their finite range fails.

Invalid input, commands, flags, file errors, and cycles exit non-zero with a useful
stderr message. Cycles include a concrete repeated-start chain, selected by sorted
DFS over dependency links. Paths starting with `-` can be supplied with `./`.
