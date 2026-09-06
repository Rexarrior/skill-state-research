# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "A&B" }); // Hello, A&amp;B!
```

Run it from the command line with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

## Syntax

- `{{path.to.value}}` inserts HTML-escaped scalar text.
- `{{{path.to.value}}}` inserts unescaped scalar text.
- `{{#if path}}...{{else}}...{{/if}}` selects a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates an array. Use `{{this}}`, `{{this.field}}`, and `{{@index}}` for the current item; other paths refer to root data.
- `{{! comment }}` emits nothing.

Missing values render as empty text. Interpolating objects, arrays, functions, or symbols throws a `TemplateError`. Structural errors include their line and column.

Run the self-tests with `bun test`.
