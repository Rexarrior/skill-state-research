# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes interpolated values, while `{{{path}}}` inserts raw text. The renderer also supports comments (`{{! ... }}`), nested `if` blocks, and array `each` blocks:

```handlebars
{{#each users}}
  {{@index}}: {{name}}
{{else}}
  No users
{{/each}}
```

Within an `each`, `this` is the current item and `@index` is its zero-based index. A normal path is looked up on the current item first, then on the root data object. Missing values produce an empty string. Interpolating objects or functions throws an error.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Usage, file, JSON, template, and rendering errors are written to stderr with a non-zero exit status.

## Tests

```sh
bun test
```
