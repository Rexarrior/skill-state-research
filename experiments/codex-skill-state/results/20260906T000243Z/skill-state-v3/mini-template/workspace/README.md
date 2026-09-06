# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada & Bob" });
// Hello, Ada &amp; Bob!
```

Supported syntax:

- `{{path.to.value}}` for HTML-escaped interpolation
- `{{{path.to.value}}}` for raw interpolation
- `{{#if path}}...{{else}}...{{/if}}` for conditionals
- `{{#each path}}...{{else}}...{{/each}}` for arrays; use `{{this}}`, `{{this.key}}`, and `{{@index}}`
- `{{! comment }}` for comments

Run the command-line renderer with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Run the tests with `bun test`.
