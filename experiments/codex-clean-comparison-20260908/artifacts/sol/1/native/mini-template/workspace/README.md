# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values, while `{{{path}}}` leaves them raw. The renderer also supports comments, nested `if` blocks, and array `each` blocks with `{{this}}`, `{{this.property}}`, and `{{@index}}`. Normal paths inside a loop check the current item first and then fall back to the root data object. Missing values become empty strings; interpolating objects or functions throws a `TemplateError`.

```text
{{#if signedIn}}
  {{#each users}}{{@index}}: {{this.name}}{{else}}No users{{/each}}
{{else}}
  Please sign in
{{/if}}
```

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Errors are written to stderr and return a non-zero status.

Run the self-tests with `bun test`.
