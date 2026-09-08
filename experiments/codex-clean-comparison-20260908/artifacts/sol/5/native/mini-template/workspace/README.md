# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, `{{this}}`, `{{@index}}`, and
`{{! comments }}`. Blocks may be nested. Missing interpolation values produce
an empty string; interpolating objects or functions is an error.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Diagnostics are written to stderr and
return a non-zero status. Run the self-tests with `bun test`.
