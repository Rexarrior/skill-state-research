# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path.to.value}}` inserts HTML-escaped scalar text.
- `{{{path.to.value}}}` inserts unescaped scalar text.
- `{{#if path}}...{{else}}...{{/if}}` selects a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates an array. Use `{{this}}` and `{{@index}}` in the loop; other paths first use the current item, then the root data.
- `{{! comment }}` emits nothing.

Objects, arrays, functions, and other non-scalar values cannot be interpolated directly. Missing values produce an empty string. Structural template errors include their line and column.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout; errors are written to stderr with a non-zero exit status.

## Tests

```sh
bun test
```
