# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Run it from the command line with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

The language supports escaped `{{path.to.value}}` and raw `{{{path}}}` values,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, and `{{! comments }}`. Within an each
block, `{{this}}` is the item, `{{@index}}` is its zero-based index, and ordinary
paths resolve from the root data. Blocks can be nested. Missing values become an
empty string; interpolating a non-scalar value is an error.

```sh
bun test
```
