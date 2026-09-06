# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada & Bob" } });
// Hello, Ada &amp; Bob!
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, `{{#each path}}...{{else}}...{{/each}}`,
and `{{! comments }}`. Each blocks expose `{{this}}` and `{{@index}}`; regular
paths first use the current item and then fall back to root data.

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Errors are written to stderr with a non-zero
exit status. Run the self-tests with `bun test`.
