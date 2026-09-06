# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags:

- `{{path.to.value}}` — HTML-escaped interpolation
- `{{{path.to.value}}}` — unescaped interpolation
- `{{#if path}}...{{else}}...{{/if}}` — conditional blocks
- `{{#each path}}...{{else}}...{{/each}}` — array iteration, with `{{this}}` and `{{@index}}`
- `{{! comment }}` — comments

Inside `each`, fields are looked up on the current item and then enclosing items, with the root data as the final fallback. Missing values render as an empty string. Interpolating an object or function throws a positional error.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests:

```sh
bun test
```
