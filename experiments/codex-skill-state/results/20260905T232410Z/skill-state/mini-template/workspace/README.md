# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path.to.value}}` for HTML-escaped interpolation and `{{{path}}}` for raw interpolation.
- `{{#if path}}...{{else}}...{{/if}}` for conditionals.
- `{{#each path}}...{{else}}...{{/each}}` for arrays. Use `{{this}}` and `{{@index}}` inside loops; object properties are resolved from the item first and then from root data.
- `{{! comment }}` for comments.

Run from the command line:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is the only stdout output. Errors are written to stderr with a non-zero exit code.

Run the tests with `bun test` and type-check with `bun run typecheck`.
