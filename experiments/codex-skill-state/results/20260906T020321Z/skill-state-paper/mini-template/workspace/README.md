# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada" });
```

Run it from the command line with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

## Syntax

- `{{path.to.value}}` renders an HTML-escaped scalar.
- `{{{path.to.value}}}` renders a scalar without escaping.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates an array.
- Within an iteration, `{{this}}` is the item and `{{@index}}` is its zero-based index. Paths first inspect the current item, then the root data.
- `{{! comment }}` renders nothing.

Missing values render as empty text. Objects and functions cannot be interpolated. Invalid block structure throws a `TemplateError` with a line and column.

## Development

```sh
bun test
```
