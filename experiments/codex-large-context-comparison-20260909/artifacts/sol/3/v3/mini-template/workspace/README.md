# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada & Bob" } });
// Hello, Ada &amp; Bob!
```

## Syntax

- `{{path.to.value}}` inserts HTML-escaped scalar text.
- `{{{path.to.value}}}` inserts unescaped scalar text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates an array. Use `{{this}}`, `{{@index}}`, or fields on the current item; other paths fall back to root data.
- `{{! comment }}` emits nothing.

Missing values render as empty text. Interpolating objects or functions throws an error. Structural errors include their line and column.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Diagnostics are written to stderr and return a non-zero exit status.

## Test

```sh
bun test
```
