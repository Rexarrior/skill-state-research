# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, and `{{! comments }}`. Within an
iteration, `{{this}}` and `{{@index}}` refer to the item and its zero-based
index. Blocks may be nested.

Run the CLI with:

```sh
bun run src/cli.ts template.txt data.json
```

It writes only rendered text to stdout. Errors are written to stderr and cause
a non-zero exit status.

Run the self-tests with `bun test`.
