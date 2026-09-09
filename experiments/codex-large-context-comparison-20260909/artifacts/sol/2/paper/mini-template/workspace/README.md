# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Double braces HTML-escape values; triple braces (`{{{value}}}`) do not. The
renderer supports dotted paths, comments (`{{! ... }}`), nested `if` blocks,
and nested `each` blocks with optional `else` branches. Within `each`, use
`{{this}}` for the current item and `{{@index}}` for its zero-based index.
Normal paths try the current item before falling back to the root data.

```text
{{#if user.active}}
  {{#each user.tags}}{{@index}}: {{this}}{{else}}No tags{{/each}}
{{else}}
  Inactive
{{/if}}
```

Run the CLI with a UTF-8 template and a JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Diagnostics are written to stderr and
return a non-zero status. Run the self-tests with `bun test`.
