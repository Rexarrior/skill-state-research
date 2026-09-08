# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes interpolated scalar values, while `{{{path}}}` inserts
them unchanged. Missing and null values become empty strings. Objects and
functions cannot be interpolated. The supported blocks are:

```handlebars
{{#if enabled}}yes{{else}}no{{/if}}
{{#each items}}{{@index}}: {{this}}{{else}}no items{{/each}}
{{! comments produce no output }}
```

Blocks may be nested. In an `each` block, paths are looked up on the current
item and then enclosing items before falling back to the root data.

Run from the command line with:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout without an added newline. Diagnostics
go to stderr and return a non-zero status. Run the self-tests with `bun test`.
