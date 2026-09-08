# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path.to.value}}` — HTML-escaped interpolation
- `{{{path.to.value}}}` — raw interpolation
- `{{#if path}}...{{else}}...{{/if}}` — conditional blocks
- `{{#each path}}...{{else}}...{{/each}}` — array iteration, with `{{this}}` and `{{@index}}`
- `{{! comment }}` — comments

Blocks may be nested. Within `each`, paths beginning with `this` address the current item; all other normal paths address the root data.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Errors are written to stderr and return a non-zero status.

## Tests

```sh
bun test
```
