# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes interpolated scalars, while `{{{path}}}` inserts them
unchanged. The renderer also supports nested `{{#if path}}...{{else}}...{{/if}}`
and `{{#each path}}...{{else}}...{{/each}}` blocks, `{{this}}`, `{{@index}}`,
and `{{! comments }}`. Missing values become empty strings; objects and functions
cannot be interpolated as text.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is the only stdout output. Errors are written to stderr and
return a non-zero exit status.

Run the tests:

```sh
bun test
```
