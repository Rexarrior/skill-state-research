# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada & Co." } });
// Hello, Ada &amp; Co.!
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, `{{#each path}}...{{else}}...{{/each}}`,
and `{{! comments }}`. Loops expose `{{this}}` and `{{@index}}`; object fields on
the current item are resolved before falling back to root data.

Run the CLI with two UTF-8 files. Its stdout contains only rendered output:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests with `bun test`.
