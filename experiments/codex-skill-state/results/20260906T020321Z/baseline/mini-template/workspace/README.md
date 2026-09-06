# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path.to.value}}` for HTML-escaped interpolation
- `{{{path.to.value}}}` for raw interpolation
- `{{#if path}}...{{else}}...{{/if}}` for conditionals
- `{{#each path}}...{{else}}...{{/each}}` for arrays; `this` and `@index` are available inside
- `{{! comment }}` for comments

Objects and functions cannot be interpolated directly. Missing values render as an empty string.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Errors are written to stderr with a non-zero exit status.

Run the tests with:

```sh
bun test
```
