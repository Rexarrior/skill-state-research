# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` inserts raw scalar text. The renderer also supports comments, nested `if` blocks, and array `each` blocks:

```handlebars
{{#each users}}
  {{@index}}: {{this.name}}
{{else}}
  No users
{{/each}}
```

Inside a loop, `this` is the item and `@index` is its zero-based index. Other paths read from the root data. Missing values become empty strings; interpolating an object, array, or function throws an error.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. File, JSON, template, and argument errors are written to stderr and set a non-zero exit status.

## Tests

```sh
bun test
```
