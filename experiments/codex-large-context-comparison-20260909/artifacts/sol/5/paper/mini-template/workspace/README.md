# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada" }); // "Hello, Ada!"
```

## Template syntax

- `{{path.to.value}}` inserts an HTML-escaped scalar value.
- `{{{path.to.value}}}` inserts a scalar value without escaping.
- `{{#if path}}...{{else}}...{{/if}}` renders a conditional branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates an array, exposing `{{this}}` and `{{@index}}`.
- `{{! comment }}` emits nothing.

Inside an `each` block, ordinary paths first use the current item and then fall back to the root data. Missing values render as empty text. Interpolating an object, array, function, or symbol throws an error.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Usage, file, JSON, and template errors are written to stderr with a non-zero exit status.

## Development

```sh
bun test
```
