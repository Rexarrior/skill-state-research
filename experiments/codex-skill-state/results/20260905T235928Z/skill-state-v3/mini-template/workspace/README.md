# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path}}` for HTML-escaped interpolation and `{{{path}}}` for raw interpolation.
- `{{#if path}}...{{else}}...{{/if}}` for conditionals.
- `{{#each path}}...{{else}}...{{/each}}` for array iteration. Use `{{this}}` and `{{@index}}` inside a loop; fields on the current item are checked before root data.
- `{{! comment }}` for comments.

Blocks can be nested. Missing values render as empty text, while interpolating objects, arrays, or functions throws an error.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Errors are written to stderr and produce a non-zero exit status.

## Tests

```sh
bun test
```
