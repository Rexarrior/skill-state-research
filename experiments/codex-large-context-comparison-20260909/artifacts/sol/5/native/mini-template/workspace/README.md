# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values, while `{{{path}}}` inserts them unchanged. The renderer also supports comments, nested `if` blocks, and array iteration:

```handlebars
{{! a comment }}
{{#if users}}
  {{#each users}}{{@index}}: {{name}} ({{this.role}}){{else}}No users{{/each}}
{{else}}
  Missing users
{{/if}}
```

Inside `each`, `this` is the current item and `@index` is its zero-based index. Ordinary paths search the current and enclosing loop items before falling back to the root data. Missing interpolations produce an empty string; interpolating objects or functions throws an error.

Run from the command line with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Diagnostics are written to stderr with a non-zero exit status. Run the self-tests with `bun test`.
