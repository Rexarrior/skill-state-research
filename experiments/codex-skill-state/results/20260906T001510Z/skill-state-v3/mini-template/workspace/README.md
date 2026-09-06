# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path}}` inserts HTML-escaped scalar text; `{{{path}}}` inserts raw text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders nested content.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays. Use `{{this}}` and `{{@index}}` inside a loop; ordinary paths check the current item and then the root data.
- `{{! comment }}` emits nothing.

Missing values render as empty text. Interpolating an object, array, function, or other non-scalar value throws an error. Structural errors include their line and column.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is the only stdout output. Run the test suite with `bun test`.
