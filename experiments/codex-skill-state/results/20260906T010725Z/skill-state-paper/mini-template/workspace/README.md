# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada & Bob" });
// "Hello, Ada &amp; Bob!"
```

Supported tags:

- `{{path.to.value}}` — HTML-escaped interpolation
- `{{{path.to.value}}}` — unescaped interpolation
- `{{#if path}}...{{else}}...{{/if}}` — conditional block
- `{{#each path}}...{{else}}...{{/each}}` — array iteration with `{{this}}` and `{{@index}}`
- `{{! comment }}` — comment

Blocks can be nested. Within an `each`, paths first look at the current item and enclosing items, then the root data.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. File, JSON, template, and usage errors are written to stderr and return a non-zero status.

## Test

```sh
bun test
```
