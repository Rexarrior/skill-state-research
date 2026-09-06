# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` inserts raw scalar text.
Conditionals use `{{#if path}}...{{else}}...{{/if}}`; array iteration uses
`{{#each path}}...{{else}}...{{/each}}`. Inside a loop, `{{this}}` and
`{{@index}}` refer to the item and index. Blocks can be nested, comments use
`{{! ... }}`, and all non-tag whitespace is preserved.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Errors are written to stderr and return
a non-zero exit status.

Run the tests with `bun test`.
