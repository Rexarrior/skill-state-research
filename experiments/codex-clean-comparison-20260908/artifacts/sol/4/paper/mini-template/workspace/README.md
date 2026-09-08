# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada" });
```

Use the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

## Syntax

- `{{path.to.value}}` inserts HTML-escaped scalar text.
- `{{{path.to.value}}}` inserts raw scalar text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates an array. Use `{{this}}` and `{{@index}}` inside it.
- `{{! comment }}` emits nothing.

Blocks may be nested. Within a loop, ordinary paths first use the current item and then the root data. Missing values render as empty text; interpolating objects or functions throws an error.

Run the self-tests with `bun test`.
