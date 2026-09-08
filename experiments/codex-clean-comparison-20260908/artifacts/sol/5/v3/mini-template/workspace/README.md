# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path.to.value}}` inserts HTML-escaped scalar text.
- `{{{path.to.value}}}` inserts unescaped scalar text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders content.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays; use `{{this}}` and `{{@index}}` inside.
- `{{! comment }}` emits nothing.

Objects and functions cannot be interpolated directly. Missing values produce an empty string. Invalid block structure is reported with its line and column.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout; errors are written to stderr with a non-zero exit status.

## Tests

```sh
bun test
```
