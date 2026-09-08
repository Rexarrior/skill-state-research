# Mini Template

A dependency-free template renderer for Bun and TypeScript.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}` values, raw `{{{path}}}` values, nested
`{{#if path}}...{{else}}...{{/if}}` blocks, array
`{{#each path}}...{{else}}...{{/each}}` blocks, and `{{! comments }}`. Within
an `each` block, use `{{this}}`, `{{this.property}}`, and `{{@index}}`; other
paths first check the current item and then fall back to the root data.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Diagnostics are written to stderr and use
a non-zero exit status. Run the self-tests with `bun test`.
