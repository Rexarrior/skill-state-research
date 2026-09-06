# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada" });
```

Supported syntax:

- `{{path.to.value}}` for HTML-escaped interpolation
- `{{{path.to.value}}}` for unescaped interpolation
- `{{#if path}}...{{else}}...{{/if}}` for conditions
- `{{#each path}}...{{else}}...{{/each}}` for arrays
- `{{this}}` and `{{@index}}` inside loops
- `{{! comment }}` for comments

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Run tests with `bun test`.
