# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
// Hello, Ada!
```

Supported syntax:

- `{{path}}` HTML-escapes `&`, `<`, `>`, `"`, and `'`; `{{{path}}}` does not.
- `{{#if path}}...{{else}}...{{/if}}` supports nested conditional blocks.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays with `{{this}}` and `{{@index}}`.
- `{{! comment }}` is discarded. All text outside tags is preserved unchanged.

Run the CLI:

```sh
bun run src/cli.ts TEMPLATE_FILE DATA.json
```

Run self-tests:

```sh
bun run test
```
