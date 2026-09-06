# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Run it from the command line (rendered text is the only stdout output):

```sh
bun run src/cli.ts template.txt data.json
```

## Syntax

- `{{path.to.value}}` inserts HTML-escaped text.
- `{{{path.to.value}}}` inserts unescaped text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays. Use `{{this}}` and `{{@index}}`; item properties are resolved before falling back to root data.
- `{{! comment }}` renders nothing.

Missing values render as empty strings. Objects, functions, and other non-scalar interpolation values throw an error. Block syntax errors include their line and column.

```sh
bun test
bun run typecheck
```
