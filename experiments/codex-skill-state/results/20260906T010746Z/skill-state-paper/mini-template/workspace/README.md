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

## Template language

- `{{path.to.value}}` inserts HTML-escaped text; `{{{path}}}` inserts raw text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays. Use `{{this}}` for the item and `{{@index}}` for its index. Item properties are checked before root properties.
- `{{! comment }}` emits nothing.

Missing values produce no text. Interpolating objects, functions, or symbols throws an error, as do malformed block structures. Syntax errors include a one-based line and column.

Run the self-tests with `bun test`.
