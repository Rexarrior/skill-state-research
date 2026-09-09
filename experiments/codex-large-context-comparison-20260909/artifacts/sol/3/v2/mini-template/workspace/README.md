# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Run it from the command line with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

## Syntax

- `{{path.to.value}}` inserts HTML-escaped scalar text.
- `{{{path.to.value}}}` inserts unescaped scalar text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates an array. Use `{{this}}`, `{{this.property}}`, and `{{@index}}` inside it. Other paths first inspect the current item, then the root data.
- `{{! comment }}` emits nothing.

Missing and null interpolation values produce an empty string. Interpolating an object, array, or function is an error. Invalid block structure reports a one-based line and column.

## Development

```sh
bun test
bun run typecheck
```
