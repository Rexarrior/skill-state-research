# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada" });
```

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Errors are written to stderr and return a non-zero exit status.

## Syntax

- `{{path.to.value}}` inserts HTML-escaped scalar text.
- `{{{path.to.value}}}` inserts unescaped scalar text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays, exposing `this` and `@index`.
- `{{! comment }}` emits nothing.

Inside loops, regular paths first use the current item and then fall back to root data. Objects and functions cannot be interpolated as scalar text.

Run the self-tests with `bun test`.
