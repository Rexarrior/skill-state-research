# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello {{user.name}}!", { user: { name: "Ada" } });
```

`{{value}}` HTML-escapes interpolated text; `{{{value}}}` leaves it raw. The renderer also supports nested `{{#if path}}...{{else}}...{{/if}}` and `{{#each path}}...{{else}}...{{/each}}` blocks, `{{this}}`, `{{@index}}`, dotted paths, and `{{! comments }}`. Missing values become empty text. Objects and functions cannot be interpolated directly.

Run from the command line:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Diagnostics are written to stderr and return a non-zero status.

Run the tests with `bun test`.
