# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada" });
```

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

## Template syntax

- `{{path.to.value}}` renders HTML-escaped scalar text.
- `{{{path.to.value}}}` renders unescaped scalar text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays. Use `{{this}}` and `{{@index}}` in the body.
- `{{! comment }}` renders nothing.

Blocks may be nested. Inside a loop, ordinary paths first use the current item and then fall back to root data. Missing values render as empty text. Interpolating objects, arrays, functions, or symbols throws a `TemplateError` instead of producing an ambiguous string.

## Development

```sh
bun test
bunx tsc --noEmit
```
